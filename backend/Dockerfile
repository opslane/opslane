FROM python:3.11-slim

WORKDIR /app

# Install system dependencies
RUN apt-get update && apt-get install -y \
    gcc \
    libpq-dev \
    && rm -rf /var/lib/apt/lists/*

# Install Poetry
RUN pip install poetry

# Copy only requirements to cache them in docker layer
COPY pyproject.toml poetry.lock* /app/

# Project initialization:
RUN poetry config virtualenvs.create false \
    && poetry install --no-interaction --no-ansi

# Copy project
COPY . /app

# Print directory structure for debugging
RUN echo "Directory structure:" && ls -R

# Print content of main.py for debugging
RUN echo "Content of main.py:" && cat app/main.py

# Run the application with verbose output
CMD ["uvicorn", "app.main:create_app", "--host", "0.0.0.0", "--port", "8000", "--log-level", "debug"]
