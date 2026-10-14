-- Revierte 0111: devuelve a cada conjunto su rótulo de sector viejo, por nombre
-- (los 42 del catálogo como estaban en dev el 13-oct-2026; producción tiene los
-- mismos desde la copia del 7-sep). Un conjunto que no esté en la lista se queda
-- sin rótulo. Al volver, el cobro vuelve a usar el rótulo como último recurso.

BEGIN;

UPDATE public.residences r SET sector = v.sector
  FROM (VALUES
  ('Alto Vallejo / Loma Linda', 'Sur-oeste'),
  ('Arándanos de Fontibón', 'Norte'),
  ('Boral Apartamentos', 'Sur-oeste'),
  ('Bosques del Norte', 'Norte'),
  ('Campo Santander', 'Norte'),
  ('Campus Reservado', 'Sur-oeste'),
  ('Casa azul Llanito', 'Sur-oeste'),
  ('Club Verde Terra', 'Sur'),
  ('Condominio Planté', 'Oriente'),
  ('Ébano Apartamentos', 'Sur'),
  ('Edificio Cámbulo', 'Sur-oeste'),
  ('Edificio Eucalipto', 'Sur-oeste'),
  ('Edificio Las Margaritas', 'Sur-oeste'),
  ('Edificio Los Cerezos', 'Norte'),
  ('Edificio Sendai', 'Sur'),
  ('Forest Apartamentos', 'Sur-oeste'),
  ('Guayacán', 'Sur-oeste'),
  ('Hábitat', 'Sur'),
  ('Linda Granja', 'Sur-oeste'),
  ('Llanito', 'Sur-oeste'),
  ('Llanogrande', 'Llanogrande'),
  ('Madero del Lago', 'Sur-oeste'),
  ('Marinilla centro', 'Oriente'),
  ('Marinilla vereda', 'Oriente'),
  ('Olivar Apartamentos', 'Norte'),
  ('Origen del Lago', 'Sur-oeste'),
  ('Piedemonte Apartamentos', 'Norte'),
  ('Portobello', 'Sur'),
  ('Portón del Rosal', 'Rosal'),
  ('Quintas Amarillas', 'Sur-oeste'),
  ('Quintas Blancas', 'Sur-oeste'),
  ('Rincones de Llanogrande', 'Llanogrande'),
  ('Río Vivo', 'Norte'),
  ('Senderos de San Sebastián', 'Norte'),
  ('Séptima', 'Sur-oeste'),
  ('Solare Apartamentos', 'Sur-oeste'),
  ('Tejo', 'Sur-oeste'),
  ('Torres del Campo', 'Sur'),
  ('Urb. Bosque Robledal', 'Oriente'),
  ('Urb. Manzanillos', 'Norte'),
  ('Viverdi Apartamentos', 'Sur-oeste')
  ) AS v(name, sector)
 WHERE r.name = v.name AND r.sector IS NULL;

COMMENT ON COLUMN public.residences.sector IS
  'Etiqueta para humanos en el tablero (Norte, Llanogrande…). OJO: NO usar para agrupar rutas — se midió que agrupar por nombre de sector no corresponde a la cercanía real por vía; eso lo decide la matriz de tiempos.';

COMMIT;
