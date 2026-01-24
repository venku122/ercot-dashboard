FROM python:3.12-slim

WORKDIR /app

COPY server.py /app/server.py
COPY web /app/web

RUN mkdir -p /app/data

ENV HOST=0.0.0.0
ENV PORT=8080

EXPOSE 8080

CMD ["python", "/app/server.py"]
