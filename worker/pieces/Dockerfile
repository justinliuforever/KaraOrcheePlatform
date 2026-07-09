FROM python:3.12-slim

WORKDIR /app
COPY requirements.txt ./
RUN apt-get update && apt-get install -y --no-install-recommends fluidsynth ffmpeg \
 && pip install --no-cache-dir -r requirements.txt \
 && playwright install --with-deps webkit \
 && rm -rf /var/lib/apt/lists/*

COPY . .
ENV PYTHONUNBUFFERED=1
CMD ["python", "main.py"]
