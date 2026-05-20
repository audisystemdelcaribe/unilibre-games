# Restaurar base de datos Supabase

Si perdiste acceso al dashboard o necesitas recrear el proyecto:

## Archivo principal

**[`full-database-restore.sql`](./full-database-restore.sql)**

Incluye:

- Todas las tablas `public.*` usadas por la app
- Índices y restricciones únicas
- Funciones: `insert_game_answer`, `registrar_puntaje_ganado`, `add_player_time`, `is_admin`, `is_staff`
- Trigger `on_auth_user_created` → crea fila en `players` al registrarse
- Políticas RLS completas
- Semilla mínima: modos de juego (1–3) y comodines

**No incluye** tus datos reales (preguntas, usuarios, eventos jugados).

## Pasos

1. Crea un proyecto en [supabase.com](https://supabase.com) (o usa uno vacío).
2. **SQL Editor** → pega y ejecuta `full-database-restore.sql` completo.
3. En **Project Settings → API**, copia URL y keys al `.env` de la app.
4. Crea el primer administrador:
   - **Authentication → Users → Add user** (correo `@unilibre.edu.co`).
   - En SQL Editor:
     ```sql
     UPDATE public.players SET role = 'admin' WHERE auth_user_id = '<uuid-del-usuario>';
     ```
5. Desde el dashboard de la app: facultades, programas, temporadas, niveles, preguntas.

## Otros scripts útiles

| Archivo | Uso |
|---------|-----|
| `reset-prueba.sql` | Borra solo partidas/eventos; mantiene catálogo y preguntas |
| `rls-policies.sql` | Solo políticas RLS (si las tablas ya existen) |
| `migrations/*.sql` | Cambios incrementales históricos |

## Recuperar datos del proyecto anterior

El archivo `full-database-restore.sql` solo crea **tablas vacías**. Los datos dependen de si aún puedes hablar con el proyecto viejo.

### ¿Tienes todavía las keys del `.env`?

Si en tu máquina (o en Vercel) sigue el `.env` del proyecto **anterior** (`PUBLIC_SUPABASE_URL` + `SUPABASE_SECRET_KEY`), la base **sigue existiendo** aunque no entres al navegador. Puedes sacar un backup así:

#### Opción A — Scripts del proyecto (sin instalar CLI)

En la raíz del repo, con el `.env` apuntando al proyecto **viejo**:

```bash
npm run db:export
```

Guarda la carpeta `supabase/backup/AAAA-MM-DD/` (JSON por tabla + `auth_users.json`).

Para el proyecto **nuevo**: ejecuta `full-database-restore.sql`, cambia `.env` al proyecto nuevo y:

```bash
npm run db:import -- --from supabase/backup/AAAA-MM-DD
```

Los usuarios Auth se recrean **sin la misma contraseña**; después usa **Usuarios → Crear usuario** o “olvidé contraseña” en Auth.

#### Opción B — Supabase CLI (sin instalar global)

```bash
npx supabase login
npx supabase link --project-ref XXXX
npx supabase db dump --data-only -f backup-datos.sql
```

#### Opción C — Supabase CLI global

```bash
npm install -g supabase
supabase login
supabase link --project-ref XXXX
supabase db dump --data-only -f backup-datos.sql
```

#### Opción B — `pg_dump` con la contraseña de base de datos

En Supabase: **Project Settings → Database → Connection string** (URI). Si no ves el panel, pide la URI a quien creó el proyecto o búscala en documentación interna.

```bash
pg_dump "postgresql://postgres.[ref]:[PASSWORD]@aws-0-[region].pooler.supabase.com:6543/postgres" ^
  --schema=public ^
  --data-only ^
  --no-owner ^
  -f backup-public.sql
```

Para incluir usuarios de login (`auth.users`), hace falta un dump con permisos sobre el esquema `auth` (a veces solo con la conexión directa `port 5432`, no el pooler).

---

### Importar el backup en un proyecto nuevo

1. Ejecuta primero **`full-database-restore.sql`** en el proyecto **nuevo** (tablas vacías + RLS).
2. Luego importa datos:

```bash
# Con psql (connection string del proyecto NUEVO)
psql "postgresql://..." -f backup-datos.sql
```

**Orden recomendado** si importas tablas a mano (por foreign keys):

1. `faculties`, `programs`, `subjects`, `program_subjects`
2. `seasons`, `game_modes`, `game_levels`, `lifelines`
3. `fastest_finger_sequences`, `fastest_finger_items`
4. `questions`, `answers`
5. `events`, `event_rounds`
6. Usuarios: `auth.users` (si lo tienes en el dump) → `players`
7. Partidas: `event_players`, `game_sessions`, `game_answers`, `round_questions_shown`, etc.

Si el dump intenta crear tablas que ya existen, usa solo la parte **data** (`--data-only`) o edita el SQL para dejar solo `COPY` / `INSERT`.

**Conflicto de IDs:** después de importar, resetea secuencias:

```sql
SELECT setval(pg_get_serial_sequence('public.questions', 'id'), COALESCE((SELECT MAX(id) FROM public.questions), 1));
-- Repetir para events, players, game_levels, etc.
```

---

### Si NO tienes backup ni acceso al proyecto viejo

No hay forma mágica de recuperar preguntas o historial: hay que **reconstruir manualmente** desde la app:

| Qué | Dónde en la app |
|-----|------------------|
| Facultades, programas, materias | Dashboard → Facultades / Programas / Materias |
| Temporadas, niveles, comodines | Temporadas, Niveles, Comodines |
| Preguntas y respuestas | Banco de Preguntas |
| Secuencias Mente más Rápida | Mente más Rápida |
| Eventos / salones | Eventos |
| Usuarios y roles | Usuarios (crear + asignar rol) o registro estudiantil |

**Usuarios:** cada persona debe volver a existir en **Authentication**. Opciones:

- Crearlos uno a uno en **Usuarios → Crear usuario** (admin).
- Que se registren en `/registro` y tú les cambias el rol.
- Si recuperaste un dump con `auth.users`, importarlo en el proyecto nuevo (misma contraseña hash; delicado, mejor con ayuda de alguien que maneje Postgres).

**Historial de partidas** (quién jugó, puntajes, PINs): solo vuelve si importaste `event_rounds`, `event_players`, `game_answers`, etc. Si no hay dump, ese historial se pierde.

---

### Otras vías

- **Vercel / otro hosting:** revisa variables de entorno guardadas (`SUPABASE_SECRET_KEY` del proyecto viejo).
- **Compañeros:** quien tenga acceso al dashboard puede exportar desde **Database → Backups** o ejecutar el `db dump`.
- **Plan de pago Supabase:** soporte a veces restaura backups automáticos (PITR) si contactas con el **project ref**.
- **Correo de Supabase:** enlace “reset password” de la cuenta que creó el proyecto para recuperar el **login del dashboard**, no los datos de la app.

---

### Error «duplicate key» al crear preguntas

Tras importar un backup con IDs fijos, el contador automático puede desfasarse. **La app ya asigna IDs nuevos sola** al guardar preguntas (no hace falta entrar a Supabase). Si alguien con acceso al SQL Editor quiere alinear el contador del servidor, puede ejecutar `SELECT public.sync_questions_answers_sequences();` (migración `013_sync_questions_answers_sequences.sql`).

---

### Resumen rápido

| Situación | Qué hacer |
|-----------|-----------|
| Tienes `.env` del proyecto viejo | `supabase db dump` → importar en proyecto nuevo |
| Recuperaste login al dashboard | Database → Backups o SQL export |
| Proyecto borrado y sin backup | Esquema con `full-database-restore.sql` + cargar catálogo en la app |
| Solo quieres seguir jugando sin historial | Esquema + semillas + crear preguntas/eventos de nuevo |
