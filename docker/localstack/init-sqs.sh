#!/bin/bash
# Script de inicialização das filas SQS FIFO no LocalStack (executado em /etc/localstack/init/ready.d/).

# Fila principal de entrada de transações de apostas
awslocal sqs create-queue \
  --queue-name wager-transactions.fifo \
  --attributes FifoQueue=true,ContentBasedDeduplication=true

# Dead Letter Queue (DLQ) para mensagens inválidas ou que excederam o limite de tentativas
awslocal sqs create-queue \
  --queue-name wager-transactions-dlq.fifo \
  --attributes FifoQueue=true,ContentBasedDeduplication=true

# Fila de publicação dos eventos de integração gerados pelo Transactional Outbox
awslocal sqs create-queue \
  --queue-name wager-events.fifo \
  --attributes FifoQueue=true,ContentBasedDeduplication=true


# Dead Letter Queue (DLQ) para mensagens inválidas ou que excederam o limite de tentativas
awslocal sqs create-queue \
  --queue-name wager-transactions-dlq.fifo \
  --attributes FifoQueue=true,ContentBasedDeduplication=true

# Fila de publicação dos eventos de integração gerados pelo Transactional Outbox
awslocal sqs create-queue \
  --queue-name wager-events.fifo \
  --attributes FifoQueue=true,ContentBasedDeduplication=true