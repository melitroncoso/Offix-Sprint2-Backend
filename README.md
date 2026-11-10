# Offix Backend

## Instalación

npm install

Copiar ".env.example" a ".env" y configurar "JWT_SECRET" con una clave segura.

npx prisma generate
npx prisma migrate deploy
npm run dev

La API se inicia en "http://localhost:3000" (o en el puerto indicado en "PORT").

## Archivos principales
- src/server.ts: servidor HTTP, rutas y lógica del backend.
- prisma/schema.prisma: modelos de datos.
- prisma/migrations/: migraciones versionadas.
- .env.example: ejemplo de variables de entorno.


