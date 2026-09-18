# Conectar KōmiVerso con Supabase + Prisma

## 1. Schema actualizado

Copia `schema.prisma` a `tu-server/prisma/schema.prisma`.

Campos nuevos respecto al anterior:
- `Usuario`: `username`, `passHash`, `avatar`, `bio`
- `ListaManga`: `cover`, `favorito`
- `Comentario`: `chapterId`, `spoiler`

Luego en el server:

```bash
npx prisma db push
npx prisma generate
```

## 2. Dependencias

```bash
npm install @prisma/client bcryptjs
npm install -D prisma
# si usas ES modules y Express ya lo tienes
```

## 3. Montar las rutas

En tu `server.js` / `index.js` del backend:

```js
import { PrismaClient } from "@prisma/client";
import { createPrismaRoutes } from "./prisma-auth-routes.js";

const prisma = new PrismaClient();
app.use("/api", createPrismaRoutes(prisma));
```

Asegúrate de tener `express.json()` antes:

```js
app.use(express.json({ limit: "2mb" })); // avatar base64 puede ser grande
```

## 4. Endpoints

| Método | Ruta | Uso |
|--------|------|-----|
| POST | `/api/auth/signup` | `{ email, username, password }` |
| POST | `/api/auth/login` | `{ email, password }` |
| POST | `/api/auth/recover` | `{ email, password }` |
| PATCH | `/api/auth/profile` | `{ email, username?, bio?, avatar? }` |
| GET | `/api/library/:email` | biblioteca completa |
| POST | `/api/library/set-status` | `{ email, manga, listKey }` |
| POST | `/api/library/toggle-favorite` | `{ email, manga }` |
| GET | `/api/comments/:mangaId` | comentarios de la obra |
| GET | `/api/comments/:mangaId/:chapterId` | comentarios del cap |
| POST | `/api/comments` | `{ email, mangaId, chapterId?, text, spoiler }` |

## 5. Frontend

El `App.jsx` actualizado llama a estos endpoints en lugar de `window.storage` para auth y biblioteca.
El historial de lectura y preferencias de tema siguen en local (dispositivo).


## Catálogo incremental de KōmiVerso

El backend lee el catálogo generado por el scraper desde `../Scraper/manhwas.json` (respecto a `KomiVerso-server`), es decir, por defecto: `~/Scraper/manhwas.json`.

Si el archivo está en otra ubicación, define la variable de entorno `MANHWAS_FILE` con la ruta absoluta al JSON.

Endpoints del catálogo:
- `GET /api/manhwa` — búsqueda, filtros y listado.
- `GET /api/manhwa/:id` — detalle y capítulos.
- `GET /api/manhwa/:id/chapter/:chapter` — páginas del capítulo.

La cuenta, comentarios y listas siguen usando sus rutas existentes.
