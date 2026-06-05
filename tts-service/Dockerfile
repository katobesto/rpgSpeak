FROM python:3.11-slim

WORKDIR /app

# wget/curl necesarios para descargar el binario Piper en ARM64
RUN apt-get update && apt-get install -y --no-install-recommends \
    wget curl \
    && rm -rf /var/lib/apt/lists/*

# Dependencias Python
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

COPY tts_server.py .

# El directorio de datos se monta como volumen en producción
# (modelos de voz, binario Piper, DB de voz)
RUN mkdir -p /app/data/tts

EXPOSE 8020

CMD ["python", "tts_server.py", "--port", "8020", "--data-dir", "/app/data"]
