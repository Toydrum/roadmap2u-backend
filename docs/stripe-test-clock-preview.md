# Vista previa local del publicador de TestClock

Este comando prepara una revisión de un manifiesto registrado mediante los
preparadores reales del publicador. Se ejecuta con Node 22 y las dependencias
bloqueadas del backend:

```powershell
node --import tsx scripts/stripe-test-clock-preview.ts --manifest ruta-al-manifiesto.json
```

El archivo JSON UTF-8 tiene exactamente tres campos: `schemaVersion: 1`,
`sourceSha` (40 caracteres hexadecimales en minúsculas) y `request`.
`request` contiene un `ClockInstallRequest` o un `ClockTransitionRequest`,
incluidos los snapshots y la observación de proveedor requeridos por esos
preparadores. Las fases son instalación, `advance_fence`, `ready` y `refresh`.
El archivo debe ser regular y ocupar como máximo 256 KiB. El SHA del manifiesto
se calcula sobre todos sus bytes UTF-8; cambiar espacios cambia ese SHA.

La salida JSON incluye la intención, hashes de transacción y lectura posterior,
tablas, claves, acciones y límites de envíos. Una invalidación incluye además
el descriptor de avance Stripe y su exigencia de invalidación verificada.
Los snapshots, perfiles y valores completos de los registros quedan fuera
de la salida. Los códigos de error se imprimen sin fragmentos del manifiesto
ni mensajes arbitrarios de lectura.

El único modo disponible es la vista previa. El comando lee el archivo indicado
y escribe el resultado en stdout; no descubre credenciales, consulta servicios,
reserva un diario ni ejecuta escrituras. Devuelve 0 para una vista previa válida,
1 si rechaza el archivo o la petición y 2 para argumentos no admitidos.

`physicalExecutionAllowed`, `physicalAuthorizationChecked`, `sourceShaVerified`
y `remoteStateVerified` permanecen en false. El SHA de fuente es una declaración
del manifiesto. Los datos de identidad, snapshots y proveedor son entrada
registrada; esta vista previa no comprueba que sigan vigentes. Antes de una
operación física siguen siendo necesarias la identidad e inventario actuales,
la fuente exacta verificada, el manifiesto revisado, la ventana humana concreta
y los transportes acotados con su diario y lectura posterior.

La instalación o avance físico, las cuentas y relojes de ensayo, sus permisos,
el cliente temporal y la matriz normal PWA/offline/recuperación conservan sus
requisitos y autorizaciones propios.
