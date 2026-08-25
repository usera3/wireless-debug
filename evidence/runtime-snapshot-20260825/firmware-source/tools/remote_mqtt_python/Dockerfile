ARG PYTHON_IMAGE=python:3.12-slim
FROM ${PYTHON_IMAGE}

WORKDIR /app

COPY requirements.txt .
ARG PIP_INDEX_URL=
RUN if [ -n "$PIP_INDEX_URL" ]; then \
      pip install --no-cache-dir -i "$PIP_INDEX_URL" -r requirements.txt; \
    else \
      pip install --no-cache-dir -r requirements.txt; \
    fi

COPY app.py schema.sql ws_fanout.py waveform_codec.py ./
COPY static ./static

ENV APP_HOST=0.0.0.0
ENV APP_PORT=18088
ENV CLOUD_WS_HOST=0.0.0.0
ENV CLOUD_WS_PORT=18089
EXPOSE 18088
EXPOSE 18089

CMD ["waitress-serve", "--listen=0.0.0.0:18088", "app:app"]
