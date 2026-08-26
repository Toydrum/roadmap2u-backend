# Runbook de despliegue y promoción

## Estado actual

Los workflows permanecen deshabilitados para escritura con `AWS_DEPLOY_ENABLED=false` y `AWS_ROLLBACK_ENABLED=false` fuera de una ventana aprobada. Los gates aceptan solo los literales `true`/`false`; una variable ausente o un typo falla cerrado. Este documento describe la operación una vez configurados OIDC, environments y aprobaciones; no ejecutes comandos locales para eludir esos controles.

El deploy ordinario jamás realiza el corte de `roadmap2u.com`/`www`. Ese cambio tiene su propio [runbook](dns-cutover.md).

## Precondiciones

- CI del pull request verde con checkouts hermanos de frontend y backend.
- `npm ci`, paridad byte a byte, typecheck, Vitest y synth de `dev`, `test` y `prod` exitosos.
- SHA inmutable identificado; no despliegues desde un working tree sucio.
- GitHub Environment del stage configurado según [../github-aws-setup.md](../github-aws-setup.md).
- Toolkit CDK del stage creado con el qualifier esperado y una policy `CloudFormationExecutionRole` revisada; el qualifier separa nombres/assets, no reemplaza el control de permisos.
- `Roadmap-CiBootstrap` actualizado antes que la carga y con los outputs `<stage>InventoryRuntimeBoundaryArn` y, para un release SSM, `<stage>RuntimeBoundaryArn` iguales a sus managed policies esperadas. El workflow valida ambos antes del diff. Para HMAC comprueba metadata y tags del parámetro sin leer el valor, y exige un único statement `ReadOnlySponsoredAccessHmacParameter` con `ssm:GetParameter` y el ARN exacto.
- Account ID, `us-east-1`, hosted zone ID y role ARN validados antes del job.
- El hash contractual calculado coincide entre ambos repositorios.
- Para `test`/`prod`, el mismo SHA consta como exitoso en el ambiente anterior.
- Para `prod`, un aprobador revisó el SHA inmutable, el PR, el synth/template y el cambio esperado antes de aprobar el GitHub Environment. El job registra después un `cdk diff` inmediatamente antes del deploy; esa salida es evidencia, no una segunda pausa de aprobación.
- El preflight `oidc-preflight.yml` pasó para el repo/stage y confirmó únicamente `sts:GetCallerIdentity` en la cuenta esperada.
- El inventario de certificados ACM sin tags quedó registrado y siguen válidas las fronteras de confianza aceptadas en el [límite de aislamiento del etiquetado inicial](../architecture.md#límite-de-aislamiento-durante-el-etiquetado-acm).

Mantén separados los SHA de backend y frontend si sus repositorios no avanzan al mismo commit; registra la pareja exacta desplegada por ambiente.

## Validación local sin mutaciones

Desde el backend:

```powershell
npm ci
npm run typecheck
npm test
npm run synth -- -c stage=dev -c AWS_ACCOUNT_ID=123456789012 -c HOSTED_ZONE_ID=Z0123456789ABCDEFGHIJ
npm run synth -- -c stage=test -c AWS_ACCOUNT_ID=123456789012 -c HOSTED_ZONE_ID=Z0123456789ABCDEFGHIJ
npm run synth -- -c stage=prod -c AWS_ACCOUNT_ID=123456789012 -c HOSTED_ZONE_ID=Z0123456789ABCDEFGHIJ
```

Sustituye los ejemplos por valores de la cuenta/zona que revisas. Los tres contextos son obligatorios y la región está fijada a `us-east-1`. `synth` no crea recursos, pero puede generar `cdk.out/`, que está ignorado por Git.

No uses `npm run deploy` como atajo fuera del workflow protegido. La ruta normal conserva evidencia de aprobación, SHA, diff y smoke tests.

## Flujo de pull request

1. Checkout del backend y `Toydrum/RoadMap2U` como carpetas hermanas.
2. Instalación reproducible con `npm ci` en cada repo.
3. Comparación byte a byte de los tres contratos.
4. Typecheck y Vitest del backend.
5. Synth de los tres stages con account/hosted zone de validación, sin deploy.
6. Tests Angular, build para raíz `/`, validación PWA y grep del bundle del frontend.
7. Revisión del diff de IaC y de permisos IAM.

Un PR no solicita credenciales de despliegue y no escribe en AWS.

## Deploy de backend

Orden ejecutado por el workflow autorizado:

1. Verificar `AWS_DEPLOY_ENABLED=true`, `AWS_ROLLBACK_ENABLED=false`, environment, SHA, account y región. Para el primer `dev/deploy` manual, el SHA debe ser exactamente el HEAD remoto de `main`.
2. Repetir instalación, contratos, typecheck, tests y synth. Antes de solicitar credenciales AWS, resolver el provider del artefacto desde `shared/backend-release-capabilities.json` y compararlo contra el control plane actual del stage; esto bloquea localmente una promoción incompatible. El artefacto final declara `ssm-secure-string-v1` para los tres templates que sintetiza, pero por ahora sólo coincide con `dev`; por eso este SHA no puede promoverse a `test` o `prod` hasta que cada stage complete su propia preparación SSM. Un SHA anterior al manifiesto nunca se adivina: después de autenticar y validar el marcador de release, un rollback legacy requiere además la atestación inmutable `/roadmap2u/<stage>/backend-release-capabilities/<sha>` creada tras revisar ese template.
   La lista `ACCESS_CODE_SSM_MIGRATED_STAGES` es monotónica: al preparar `test` se agrega junto a `dev`, y al preparar `prod` se agrega sin retirar los stages anteriores. Nunca se reemplaza un stage ya migrado por el siguiente.
3. Antes del diff, permitir que cada stack esté ausente (primer deploy) o exactamente en `CREATE_COMPLETE`, `UPDATE_COMPLETE` o `UPDATE_ROLLBACK_COMPLETE`. Este último permite corregir o revertir una actualización fallida ya estabilizada; cualquier estado `*_IN_PROGRESS`, `ROLLBACK_COMPLETE` de una creación fallida, import o fallo aborta.
4. Ejecutar `Validate commercial inventory control plane`: leer el output exacto del stage en `Roadmap-CiBootstrap`, comprobar igualdad con `roadmap2u-<stage>-inventory-runtime-boundary` y resolver esa policy con `iam:GetPolicy`.
5. Ejecutar el preflight HMAC seleccionado por la capacidad del artefacto sin leer valores. Para SSM, comprobar mediante APIs de metadata que el parámetro exacto es Standard `SecureString`, usa `alias/aws/ssm`, conserva los tres tags esperados y no tiene resource policy; validar también que el secreto de recuperación retenido existe, no tiene `DeletedDate`, conserva nombre/ARN/tags de proyecto y stage exactos y carece de resource policy. `DescribeParameters` sólo expone metadata, requiere `Resource: *` por diseño de AWS y queda limitado a `us-east-1`. Para un rollback legacy, aplicar las mismas comprobaciones de metadata al secreto; el secreto original no depende de un tag `purpose`. En ambos casos, resolver la versión activa del runtime boundary, normalizar acciones sin distinguir mayúsculas, comparar los statements exactos y rechazar `NotAction`, Deny relevante, `Condition` inesperada, wildcards o permisos SSM/Secrets Manager adicionales.
6. Ejecutar `cdk diff` para el stage y conservarlo como evidencia del job. El diff aprobado para DEP-011 sólo añade el ejecutor, URL, role/boundary y observabilidad; no puede mostrar `Delete` ni `Replace` de tablas, tabla de auditoría, colas, User Pool/client ni roles runtime preexistentes.
7. Desplegar solo el alcance que ya fue aprobado. El job de deploy es el único asociado al environment, por lo que `prod` conserva una sola aprobación.
8. Ejecutar el deploy no interactivo del stack o stacks de ese stage.
9. Después del deploy, aceptar únicamente `CREATE_COMPLETE` o `UPDATE_COMPLETE`; no usar el patrón permisivo `*_COMPLETE`.
10. Leer outputs y los ocho parámetros SSM; validar formato, stage y hash.
11. Verificar que todos los log groups Lambda y el access log del API existen con retención exacta de 7/14/30 días para dev/test/prod.
12. Ejecutar smokes del API y hosting.
13. Construir `/roadmap2u/{stage}/backend-release-manifests/{sha}` con `schemaVersion=1`, stage, SHA y los ocho valores de `handoff`. Crearlo sin overwrite o comprobar igualdad canónica si ya existe.
14. Solo después escribir `/backend-releases/{sha}` y finalmente el pointer `/backend-release-sha`.

El backend se despliega antes del frontend. El build web toma un snapshot consistente leyendo el pointer backend, su manifiesto inmutable y el pointer nuevamente; cualquier cambio entre ambas lecturas aborta la publicación.

## Build y publicación del frontend

El workflow frontend consulta SSM y genera un archivo TypeScript para el stage. Debe fallar si falta un campo, si `api-base-url` incluye `/v1` o si el hash no coincide.

Valores de autenticación:

- `dev`: `requireAuth=false`;
- `test` y `prod`: `requireAuth=true`.

Publicación atómica por orden:

1. Construir para raíz `/` y validar manifest/service worker.
2. Conservar los manifiestos necesarios de la versión actual y la anterior.
3. Subir assets con nombre hash usando `Cache-Control: public,max-age=31536000,immutable`.
4. Subir manifest, service workers, `ngsw.json` y punteros no versionados con `Cache-Control: no-cache`.
5. Subir `index.html` al final, también sin caché.
6. Verificar que todos los assets referenciados por `index.html` existen en S3.
7. Invalidar solo punteros no versionados; no invalidar `/*`.
8. Ejecutar smokes y registrar la pareja SHA/configuración.
9. Solo después del éxito, escribir `/roadmap2u/{stage}/frontend-releases/{sha}` y actualizar `/roadmap2u/{stage}/frontend-release-sha`.

## Promociones

### `main` → `dev`

Cuando la bandera está habilitada, un merge a `main` puede iniciar el deploy automático de `dev`. La ejecución debe asociarse al SHA exacto, no simplemente al estado posterior de la rama.

### `dev` → `test`

Promoción manual mediante `promote-aws.yml`. Selecciona un SHA con ejecución exitosa registrada en `dev`; el job comprueba `/roadmap2u/dev/frontend-releases/{sha}` antes de asumir el rol `test`. No reconstruyas desde otra rama ni introduzcas commits adicionales durante la promoción.

### `test` → `prod`

Promoción manual y aprobada mediante `promote-aws.yml`. El SHA debe tener su marcador `/roadmap2u/test/frontend-releases/{sha}`. El build puede generar configuración propia de prod, pero no cambiar el código fuente promovido. Revisa retención, PITR, deletion protection, CORS sin localhost y ausencia de aliases apex/`www` antes de aprobar.

Desplegar CloudFront/certificado productivos no publica el frontend en el dominio mientras no se ejecute el cutover DNS separado.

## Smoke tests

Ejecuta contra el hostname real del stage:

- una ruta profunda Angular responde la app y no 404 del origen;
- manifest, iconos, service worker y `ngsw.json` cargan;
- después de una carga completa, una recarga offline funciona;
- una ruta API sin token responde 401 con JSON y no contenido HTML;
- preflight acepta únicamente los orígenes de la tabla del stage;
- prod rechaza `localhost:4200` y `localhost:8826`;
- el bundle principal no contiene Amplify/Cognito (`cognito-idp`, `amazonaws.com` u otras firmas acordadas);
- cada asset que referencia `index.html` existe y devuelve 200;
- los ocho parámetros SSM están completos y `api-base-url` no termina en `/v1`;
- el hash de SSM coincide con el de la fuente del frontend.

Para producción antes del corte, prueba además la distribución por su hostname CloudFront y conserva evidencia. No cambies `/etc/hosts`, DNS público ni registros locales como sustituto de esa verificación sin una instrucción operativa aprobada.

## Rollback frontend

1. Establecer temporalmente `AWS_DEPLOY_ENABLED=false` para evitar otro deploy automático.
2. Elegir el último SHA bueno registrado para el mismo stage; `rollback-aws.yml` debe comprobar su marcador `/roadmap2u/{stage}/frontend-releases/{sha}`.
3. Regenerar su configuración leyendo SSM del stage; volver a validar el hash.
4. Republicar sus assets/manifiestos en el mismo orden seguro.
5. Publicar `index.html` al final.
6. Hacer invalidación dirigida de punteros no versionados.
7. Repetir smokes y registrar el rollback.

S3 Versioning es una red adicional, no una razón para restaurar objetos a ciegas. Prefiere republicar el artefacto reproducible del SHA bueno; conserva versiones actuales hasta terminar la ventana de observación.

## Rollback backend

1. Establecer `AWS_DEPLOY_ENABLED=false` y, solo durante la ventana de incidente, `AWS_ROLLBACK_ENABLED=true`. Si ambos gates están activos o ambos inactivos, el workflow no ejecuta cambios.
2. Seleccionar el último SHA bueno del mismo stage y revisar su `cdk diff` contra el estado actual. El workflow resuelve el provider del artefacto y exige que coincida con el control plane del stage. `dev`, ya transicionado, rechaza revisiones legacy que intentarían recrear el secreto retenido. Mientras `test`/`prod` sigan legacy, un SHA anterior al manifiesto sólo se admite si tiene tanto el marcador de release como una atestación `secrets-manager-v1` del mismo stage/SHA; el artefacto SSM actual no puede promoverse allí todavía.
3. No reemplazar ni borrar User Pools, tablas o buckets productivos.
4. Ejecutar manualmente `operation=rollback`; el workflow debe validar el marcador `/roadmap2u/{stage}/backend-releases/{sha}` antes de desplegar el template/código anterior.
5. Revalidar el almacén HMAC correspondiente al stage, el contrato y los smokes.
6. Si el incidente afecta la migración HMAC, no intentes regresar al template de preparación: conserva ambos almacenes y aplica un forward-fix compatible con SSM o restaura el parámetro desde el secreto mediante una operación revisada.
7. Si hubo cambio de schema incompatible o escritura corrupta, detener el rollback automático y ejecutar un plan de recuperación de datos específico; PITR no se restaura encima de la tabla activa sin diseño previo.
8. Al cerrar el incidente, volver a dejar ambos gates en `false`; no convertir rollback en el modo normal de despliegue.

Una atestación para un SHA anterior al manifiesto se crea únicamente después de sintetizar y revisar ese SHA y confirmar que realmente consume el secreto legacy. El owner la escribe una sola vez, sin overwrite, como `String` Standard en `/roadmap2u/<stage>/backend-release-capabilities/<sha>` con valor exacto `secrets-manager-v1`. Los roles de deploy sólo pueden leer esa ruta y no pueden crearla ni modificarla. No crees atestaciones preventivas para revisiones que nunca se desplegaron.

## Condiciones de aborto

Interrumpe el despliegue si:

- account, región, stage o hosted zone no coinciden;
- el SHA carece de éxito en el ambiente anterior;
- falla paridad/hash;
- el diff borra/reemplaza datos o identidad de prod;
- aparece localhost en CORS prod;
- S3 adquiere acceso público o CloudFront pierde OAC/HTTPS;
- un stack ordinario toca apex/`www`;
- los smokes de autenticación, PWA o assets fallan.

Después de abortar, deja `AWS_DEPLOY_ENABLED=false` y `AWS_ROLLBACK_ENABLED=false`, conserva logs/diff y abre una corrección nueva; no eludas el gate mediante un deploy local.
