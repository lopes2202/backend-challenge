-- Cria o banco de dados isolado para a suíte de testes de integração (`bun test test/integration`).
-- Executado automaticamente na inicialização do container PostgreSQL via `/docker-entrypoint-initdb.d/`.
SELECT 'CREATE DATABASE wagering_test'
WHERE NOT EXISTS (SELECT FROM pg_database WHERE datname = 'wagering_test')\gexec

