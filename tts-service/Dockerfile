FROM python:3.11-slim

WORKDIR /app

COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

COPY tts_server.py .

EXPOSE 8020

CMD ["python", "tts_server.py", "--port", "8020"]
