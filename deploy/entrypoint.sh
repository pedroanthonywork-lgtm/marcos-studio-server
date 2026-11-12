#!/bin/sh
# Se houver um pacote de dados enviado (/data/import.tgz: banco + mídias + chaves), restaura antes de ligar o servidor.
set -e
mkdir -p /data
if [ -f /data/import.tgz ]; then
  echo "[import] restaurando dados de /data/import.tgz"
  rm -f /data/studio.db /data/studio.db-wal /data/studio.db-shm
  tar -xzf /data/import.tgz -C /data
  rm -f /data/import.tgz
  echo "[import] ok"
fi
exec node server/index.ts
