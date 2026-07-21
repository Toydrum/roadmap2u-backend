# Runbook futuro de corte DNS productivo

## Aviso de seguridad

Este runbook es para una ventana futura, con aprobación explícita. **No se ejecuta durante esta entrega.** El deploy ordinario de infraestructura no administra los registros frontend de producción.

El workflow usa dos fases dentro de la misma ejecución manual:

1. `plan`, bajo el environment protegido `prod`, solo lee AWS, captura el estado y publica un artefacto inmutable;
2. `apply`, bajo un segundo environment protegido `prod-dns-cutover`, queda esperando otra aprobación y aplica exclusivamente el batch contenido en ese artefacto.

`prod` usa `DNS_PLAN_ROLE_ARN` (`prodDnsPlanRoleArn`), cuya policy no permite cambios ni escrituras. `prod-dns-cutover` usa `DNS_CUTOVER_ROLE_ARN` (`prodDnsCutoverRoleArn`), el único rol del flujo con `ChangeResourceRecordSets` y escritura del respaldo SSM. No configures el mismo ARN en ambos environments.

Las dos variables de repositorio `AWS_DEPLOY_ENABLED` y `DNS_CUTOVER_ENABLED` deben seguir en `false` fuera de la ventana aprobada. Habilitar una no sustituye la aprobación de ninguno de los environments.

Hasta el corte, deben permanecer intactos:

| Nombre | Tipo | Valor actual que se debe preservar |
|---|---|---|
| `roadmap2u.com` | A | `162.241.62.201` |
| `www.roadmap2u.com` | CNAME | `roadmap2u.com` |

No borres, conviertas ni hagas UPSERT de esos registros para “probar” CloudFront.

## Criterios de entrada

- Backend y frontend productivos desplegados por workflows protegidos con smokes verdes.
- Certificado ACM en `us-east-1` con estado `ISSUED` y nombres apex/`www` cubiertos.
- Distribución CloudFront con estado desplegado, OAC, bucket privado, HTTPS y aliases correctos.
- Redirección `www` → apex verificada en la distribución.
- API `https://api.roadmap2u.com` validada independientemente.
- PWA validada mediante hostname CloudFront: ruta profunda, assets, manifest, service worker y offline.
- Último SHA bueno y pareja backend/frontend registrados.
- Responsable, aprobador, ventana de observación y criterio de rollback definidos.
- Permisos IAM temporales para el workflow de cutover, separados de los roles de deploy ordinario.

Si cualquiera falta, posponer.

## Captura obligatoria del estado previo

Al iniciar la ejecución, el job `plan` debe leer —no inferir— la zona y guardar como artefacto inmutable:

- fecha/hora UTC;
- AWS account ID y hosted zone ID;
- SHA del workflow;
- record sets completos de apex y `www`, incluidos TTL/routing policy/identificadores;
- distribution ID y hostname CloudFront objetivo;
- estado del certificado;
- respuesta DNS observada desde al menos dos resolvers.

El artefacto `production-dns-plan-<operación>-<run>-<attempt>` contiene, como mínimo:

- `metadata.json`, ligado a cuenta, zona, repositorio, commit, run, intento y operación;
- `current-records.json`, con **todos** los record sets de apex y `www`, sin filtrarlos previamente por tipo;
- `original-records.json`, que es el snapshot previo al corte o el respaldo persistido que alimenta un rollback;
- `distribution.json`, `certificate.json` y los marcadores de release verificados;
- `resolver-observations.txt`, con respuestas previas desde `1.1.1.1` y `8.8.8.8`;
- `forward-batch.json` y `rollback-batch.json` completos;
- `plan.md`, legible para revisión humana;
- `SHA256SUMS`, que cubre todos los archivos anteriores.

`plan` no llama `ChangeResourceRecordSets` ni escribe el respaldo SSM. Si falla la captura, la validación del estado conocido, la distribución o la generación de cualquiera de los batches, no existe fase aplicable.

Una consulta de solo lectura para revisión manual es:

```powershell
aws route53 list-resource-record-sets `
  --hosted-zone-id $env:HOSTED_ZONE_ID `
  --query "ResourceRecordSets[?Name=='roadmap2u.com.' || Name=='www.roadmap2u.com.']"
```

No uses el resultado pegado en un chat como respaldo. El workflow debe conservar el JSON original para generar la operación inversa exacta.

Compara el snapshot con los valores esperados de esta guía. Si alguien cambió A, CNAME, política de routing o ownership desde que se escribió el plan, **aborta**: el estado observado tiene precedencia y requiere una nueva revisión.

## Verificación previa sin DNS público

Antes del corte:

1. Obtener el hostname de la distribución desde CloudFormation/SSM.
2. Solicitar `/`, una ruta Angular profunda y los punteros PWA usando ese hostname.
3. Comprobar status, content type, headers de seguridad y referencias de assets.
4. Confirmar que el origen S3 no es accesible públicamente.
5. Confirmar que la distribución sirve exactamente el SHA productivo aprobado.
6. Validar que el workflow de rollback puede reconstruir un change batch desde el snapshot, sin ejecutarlo.

El certificado del dominio no debe “probarse” apuntando temporalmente el apex. CloudFront puede verificarse por su hostname antes de cambiar Route 53.

## Cambio aprobado

El workflow exclusivo de cutover debe presentar `plan.md` y ambos JSON de cambios, y requerir la aprobación de `prod-dns-cutover` **después** de publicar el artefacto. El aprobador debe revisar el artifact ID/digest mostrado en el resumen del job, el snapshot y los dos batches.

Después de la aprobación, `apply` descarga por el `artifact-id` emitido por `plan`, valida automáticamente el digest de GitHub, verifica `SHA256SUMS` y confirma que metadata, cuenta, zona, commit, run, intento y operación corresponden a esa misma ejecución. Luego vuelve a leer apex/`www` y compara el resultado completo con `current-records.json`; cualquier drift aborta. El job no vuelve a calcular ni modifica el batch aprobado.

Para `cutover`, `apply` persiste en SSM el snapshot completo aprobado y ejecuta `forward-batch.json`. En una sola operación transaccional de Route 53:

1. UPSERT del A apex desde `162.241.62.201` a alias de la distribución CloudFront.
2. Crear el alias AAAA del apex si IPv6 está habilitado en la distribución.
3. Sustituir el CNAME `www → roadmap2u.com` por el/los aliases a la distribución que ejecuta la redirección permanente.

Route 53 no permite conservar un CNAME y un A/AAAA con el mismo nombre. Por eso el change batch de `www` debe eliminar el CNAME capturado y crear los aliases de forma atómica. No ejecutes primero el delete en una llamada separada.

El artefacto incluye también `rollback-batch.json`, construido antes del corte para eliminar los cuatro aliases esperados y restaurar exactamente los records administrados del snapshot. Los records de otros tipos se conservan en el snapshot completo y nunca se incluyen accidentalmente en el conjunto A/AAAA/CNAME administrado.

La distribución debe decidir la redirección por host y responder permanentemente de `https://www.roadmap2u.com/...` a `https://roadmap2u.com/...`, conservando path y query cuando corresponda.

## Validación posterior

Espera a que Route 53 marque el change como `INSYNC` y prueba mediante resolvers autoritativos y públicos:

```powershell
Resolve-DnsName roadmap2u.com -Type A
Resolve-DnsName roadmap2u.com -Type AAAA
Resolve-DnsName www.roadmap2u.com
```

Después valida:

- apex negocia certificado válido y HTTPS;
- `www` devuelve redirección permanente al apex;
- `/`, una ruta profunda y una ruta con query cargan la app;
- assets de `index.html`, manifest, iconos, service worker y `ngsw.json` devuelven 200;
- recarga offline funciona después de una visita online;
- API sin token devuelve 401 JSON;
- inicio de sesión y una operación autenticada de bajo riesgo funcionan;
- logs/métricas no muestran aumento de 4xx/5xx ni errores de origen;
- el contenido corresponde al SHA aprobado.

Mantén observación durante la ventana acordada. La propagación en caches recursivos puede hacer que usuarios distintos vean el origen anterior y CloudFront temporalmente; ambos deben permanecer operables durante esa fase.

## Rollback DNS

Activa rollback si hay fallo sostenido de TLS, loops de redirección, 403/5xx de CloudFront, rutas SPA rotas, assets faltantes, regresión crítica de autenticación/PWA o métricas fuera del umbral acordado.

El rollback usa el snapshot, no los valores recordados por una persona. Inicia una nueva ejecución manual con operación `rollback`; su fase `plan` lee el respaldo SSM, captura el estado actual y vuelve a producir un artefacto revisable. `apply` sigue requiriendo la aprobación independiente de `prod-dns-cutover` y consume exactamente ese artefacto:

1. Bloquear despliegues adicionales y conservar evidencia.
2. Revisar el `rollback-batch.json` generado por `plan`, que quita los aliases creados.
3. Restaurar exactamente el A apex capturado —esperado `162.241.62.201`— con su configuración anterior.
4. Restaurar exactamente el CNAME `www → roadmap2u.com` capturado.
5. Enviar todo en una sola operación Route 53 y esperar `INSYNC`.
6. Repetir DNS, TLS, página principal y rutas críticas contra el origen anterior.
7. Mantener CloudFront, bucket y versiones; no destruir infraestructura durante el incidente.

Si el snapshot difiere de los valores esperados, restaura el snapshot observado, no este ejemplo. Cualquier cleanup posterior es un cambio separado.

No apruebes un `apply` si cambió Route 53 después del plan, si el artifact ID no coincide con el resumen, si falla un checksum o si el rol OIDC no proviene del environment exacto. En cualquiera de esos casos descarta la ejecución y genera un plan nuevo.

## Después de un corte exitoso

- Registrar change ID, snapshot previo, SHA, aprobadores, hora y resultados de smokes.
- Mantener la versión anterior del frontend y S3 Versioning durante el periodo de seguridad.
- No retirar GitHub Pages ni cambiar el enlace “Live” hasta una decisión posterior explícita.
- Crear por separado el trabajo de observabilidad, alertas, SES y demás gates de go-live.
- Solo después de una ventana estable, evaluar si el IaC productivo debe asumir ownership de los aliases apex/`www`; importarlos o modelarlos es otra migración, no parte de este cutover inicial.
