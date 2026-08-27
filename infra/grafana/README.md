# Grafana & Prometheus Provisioning

This directory contains configuration and datasource provisioning templates for the observability stack (established in Step s-08, with full production dashboards and alerting rules landing in Step s-34).

## Architecture

- **Prometheus Scrapes**: `apps/backend` exposes `/metrics` on port 4000 (standard Prometheus text exposition format).
- **OpenTelemetry Traces**: Applications emit OTLP traces to `otel-collector` (ports 4317 gRPC / 4318 HTTP).
- **Grafana Visualization**: Reads metrics from Prometheus and traces from Jaeger/Tempo via OpenTelemetry Collector.

## Provisioning Layout

- `provisioning/datasources/datasources.yaml`: Auto-wires Prometheus and Tempo/Jaeger data sources.
- `provisioning/dashboards/dashboards.yaml`: Configures automatic dashboard providers and directories.
