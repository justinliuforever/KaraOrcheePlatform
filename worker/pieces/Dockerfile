FROM python:3.12-slim

WORKDIR /app
COPY requirements.txt ./
RUN pip install --no-cache-dir -r requirements.txt \
 && playwright install --with-deps webkit \
 && rm -rf /var/lib/apt/lists/*

COPY . .
ENV PYTHONUNBUFFERED=1
CMD ["python", "main.py"]
