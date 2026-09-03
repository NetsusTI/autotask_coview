-- resources: roster de técnicos. Se sincroniza desde Autotask (ver
-- src/lib/supabase/resources.ts → syncResourcesFromAutotask, expuesto en
-- POST /api/resources/sync). Es la tabla contra la que se valida que un nombre
-- que llega desde la extensión corresponda a un técnico real y activo.

CREATE TABLE IF NOT EXISTS resources (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  autotask_resource_id  int4 UNIQUE,
  name                  text NOT NULL,
  email                 text,
  role                  text,
  active                boolean NOT NULL DEFAULT true,
  excluded              boolean NOT NULL DEFAULT false,
  created_at            timestamptz NOT NULL DEFAULT now()
);

-- Por si la tabla ya existía desde antes sin estos defaults/constraint (dashboard).
ALTER TABLE resources ALTER COLUMN created_at SET DEFAULT now();
-- excluded: marca a alguien que Autotask sí trae como isActive pero que el admin
-- sacó a mano del roster (marketing, comercial, administración, etc). El sync
-- respeta esto y no lo reactiva; solo el botón "Reactivar" del panel lo revierte.
ALTER TABLE resources ADD COLUMN IF NOT EXISTS excluded boolean NOT NULL DEFAULT false;
-- title: el "Título"/cargo que trae Resources.title de Autotask tal cual (ej.
-- "Técnico", "Ingeniero de Soporte") — texto libre de cada instancia, sin lista fija.
-- Va SEPARADO de `role`, que sí tiene un CHECK constraint (resources_role_check)
-- agregado a mano en el dashboard de Supabase, no reflejado en este archivo — el
-- texto libre de Autotask lo violaba, por eso role se sigue fijando a 'tech' en el
-- sync y no se toca acá. `title` es la columna que se muestra en el panel admin.
ALTER TABLE resources ADD COLUMN IF NOT EXISTS title text;
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'resources_autotask_resource_id_key'
  ) THEN
    ALTER TABLE resources ADD CONSTRAINT resources_autotask_resource_id_key UNIQUE (autotask_resource_id);
  END IF;
END $$;

-- Resolver "nombre escrito/detectado" → resources.id rápido y sin problemas de mayúsculas.
CREATE INDEX IF NOT EXISTS idx_resources_name_lower ON resources (lower(name));

ALTER TABLE resources ENABLE ROW LEVEL SECURITY;
