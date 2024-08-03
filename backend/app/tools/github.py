"""GitHub-related utility functions."""

from github import Github
from datetime import datetime, timedelta
from typing import List, Dict, Any

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


def get_git_changes(query: str) -> str:
    """Retrieve and format recent Git changes."""
    git_changes = _get_recent_changes(settings.GITHUB_REPO)
    formatted_changes = []
    for commit in git_changes[:5]:  # Limit to 5 most recent commits
        commit_info = f"Commit: {commit['sha']}\n"
        commit_info += f"Message: {commit['message']}\n"
        commit_info += f"Author: {commit['author']}\n"
        commit_info += f"Date: {commit['date']}\n"
        commit_info += "Files changed:\n"
        for file in commit["files"][:3]:  # Limit to 3 files per commit
            commit_info += f"  - {file['filename']} ({file['status']})\n"
            commit_info += (
                f"    Additions: {file['additions']}, Deletions: {file['deletions']}\n"
            )
            if file["patch"]:
                commit_info += "    Patch:\n"
                patch_lines = file["patch"].split("\n")[:10]  # Limit to first 10 lines
                for line in patch_lines:
                    commit_info += f"      {line}\n"
                if len(file["patch"].split("\n")) > 10:
                    commit_info += "      ...(truncated)\n"
        formatted_changes.append(commit_info)
    return "\n\n".join(formatted_changes)
