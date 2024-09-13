"""GitHub-related utility functions."""

import json
from datetime import datetime, timedelta
from typing import List, Dict, Any, Tuple

from fuzzywuzzy import process
from langchain.tools import tool
from github import Github
from github import GithubException

from app.core.config import settings

# Initialize GitHub client
g = Github(settings.GITHUB_TOKEN)


def _get_recent_changes(repo_name: str, days: int = 1) -> List[Dict[str, Any]]:
    """Get recent changes from a GitHub repository, including file content changes."""
    repo = g.get_repo(repo_name)
    since = datetime.now() - timedelta(days=days)
    commits = repo.get_commits(since=since)

    changes = []
    for commit in commits:
        files_changes = []
        for file in commit.files:
            file_change = {
                "filename": file.filename,
                "status": file.status,
                "additions": file.additions,
                "deletions": file.deletions,
                "patch": file.patch,  # This contains the actual changes
            }
            files_changes.append(file_change)

        changes.append(
            {
                "sha": commit.sha,
                "message": commit.commit.message,
                "date": commit.commit.author.date.isoformat(),
                "author": commit.commit.author.name,
                "files": files_changes,
            }
        )

    return changes


def get_latest_git_changes(repo_name: str) -> str:
    """Retrieve and format recent Git changes."""
    git_changes = _get_recent_changes(repo_name=repo_name)
    formatted_changes = []
    for commit in git_changes[:5]:  # Limit to 5 most recent commits
        commit_info = {
            "sha": commit["sha"],
            "message": commit["message"],
            "author": commit["author"],
            "date": commit["date"],
            "link": f"https://github.com/{repo_name}/commit/{commit['sha']}",
            "files_changed": [],
        }

        for file in commit["files"][:3]:  # Limit to 3 files per commit
            file_info = {
                "filename": file["filename"],
                "status": file["status"],
                "additions": file["additions"],
                "deletions": file["deletions"],
                "patch": "",
            }
            if file["patch"]:
                patch_lines = file["patch"].split("\n")[:10]  # Limit to first 10 lines
                file_info["patch"] = "\n".join(patch_lines)
                if len(file["patch"].split("\n")) > 10:
                    file_info["patch"] += "\n...(truncated)"

            commit_info["files_changed"].append(file_info)

        formatted_changes.append(commit_info)

    return json.dumps(formatted_changes, indent=2)


def get_commit_author(repo_name: str, commit_sha: str) -> str:
    """Get the author of a specific commit."""
    try:
        repo = g.get_repo(repo_name)
        commit = repo.get_commit(commit_sha.strip())
        return commit.commit.author.name
    except Exception as e:
        return f"Error: {str(e)}"


def get_latest_file_modifier(
    repo_name: str, file_path: str, max_results: int = 5
) -> List[Tuple[str, str, float]]:
    """Get the latest person who modified files matching the given path."""
    try:
        repo = g.get_repo(repo_name)
        all_files = [content.path for content in repo.get_contents("")]
        matches = process.extract(file_path, all_files, limit=max_results)

        results = []
        for matched_file, score in matches:
            commits = repo.get_commits(path=matched_file)
            if commits.totalCount > 0:
                latest_commit = commits[0]
                results.append((matched_file, latest_commit.commit.author.name, score))
            else:
                results.append((matched_file, "No commits found", score))

        return results
    except Exception as e:
        return [("Error", str(e), 0)]


def create_revert_pr(repo_name: str, commit_sha: str) -> str:
    """Create a pull request that reverts an existing commit."""
    try:
        repo = g.get_repo(repo_name)
        commit_to_revert = repo.get_git_commit(commit_sha.strip())

        # Create a new branch
        base_branch = repo.default_branch
        new_branch_name = f"revert-{commit_sha[:7]}"
        base_ref = repo.get_git_ref(f"heads/{base_branch}")
        repo.create_git_ref(f"refs/heads/{new_branch_name}", base_ref.object.sha)

        # Get the base commit
        base_commit = repo.get_git_commit(base_ref.object.sha)

        # Create a revert commit
        revert_commit = repo.create_git_commit(
            message=f'Revert "{commit_to_revert.message}"',
            parents=[base_commit],
            tree=base_commit.tree,
            author=g.get_user().raw_data,
            committer=g.get_user().raw_data,
        )

        # Update the new branch reference
        repo.get_git_ref(f"heads/{new_branch_name}").edit(sha=revert_commit.sha)

        # Create a pull request
        pr = repo.create_pull(
            title=f"Revert '{commit_to_revert.message}'",
            body=f"This PR reverts commit {commit_sha}",
            head=new_branch_name,
            base=base_branch,
        )

        return f"Created PR #{pr.number}: {pr.html_url}"
    except Exception as e:
        return f"Error: {str(e)}"


def get_commit_contents(repo_name: str, commit_sha: str) -> str:
    """Get the contents of a specific commit."""
    try:
        repo = g.get_repo(repo_name)
        commit = repo.get_commit(commit_sha.strip())

        commit_info = f"Commit: {commit.sha}\n"
        commit_info += f"Author: {commit.commit.author.name}\n"
        commit_info += f"Date: {commit.commit.author.date.isoformat()}\n"
        commit_info += f"Message: {commit.commit.message}\n\n"
        commit_info += "Files changed:\n"

        for file in commit.files:
            commit_info += f"  - {file.filename} ({file.status})\n"
            commit_info += (
                f"    Additions: {file.additions}, Deletions: {file.deletions}\n"
            )
            if file.patch:
                commit_info += "    Patch:\n"
                patch_lines = file.patch.split("\n")[:20]  # Limit to first 20 lines
                for line in patch_lines:
                    commit_info += f"      {line}\n"
                if len(file.patch.split("\n")) > 20:
                    commit_info += "      ...(truncated)\n"
            commit_info += "\n"

        return commit_info
    except Exception as e:
        return f"Error: {str(e)}"


# Create StructuredTool for the new function
get_commit_contents_tool = StructuredTool.from_function(
    func=get_commit_contents,
    name="get_commit_contents",
    description="Get the patch of a specific commit given the commit SHA.",
)


get_github_activity_tool = StructuredTool.from_function(
    func=get_latest_git_changes,
    name="get_latest_git_changes",
    description="Fetch the latest GitHub commits and pull requests for a given repository.",
)


# Create StructuredTools for the new functions
get_commit_author_tool = StructuredTool.from_function(
    func=get_commit_author,
    name="get_commit_author",
    description="Get the author of a specific commit given the commit SHA.",
)

get_latest_file_modifier_tool = StructuredTool.from_function(
    func=get_latest_file_modifier,
    name="get_latest_file_modifier",
    description="Get the latest person who modified a specific file given the file path.",
)

create_revert_pr_tool = StructuredTool.from_function(
    func=create_revert_pr,
    name="create_revert_pr",
    description="Create a pull request that reverts an existing commit given the commit SHA.",
)
