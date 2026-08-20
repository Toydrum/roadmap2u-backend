# Configuración de GitHub Actions con AWS OIDC

## Propósito

GitHub Actions debe obtener credenciales temporales mediante OpenID Connect. No se crean ni almacenan access keys de IAM en GitHub. La configuración separa:

- repositorio frontend y repositorio backend;
- ambientes `dev`, `test` y `prod`;
- permisos de validación frente a permisos de deploy.

Esta guía se usa durante las ventanas aprobadas del rollout. Mantén todos los gates en `false` mientras se prepara GitHub o se revisan plantillas; ningún paso de bootstrap, deploy o DNS se ejecuta implícitamente por conservar este archivo en el repositorio.

## Prerrequisitos administrativos

1. Reautenticar GitHub CLI y crear el repositorio público `Toydrum/roadmap2u-backend` con licencia MIT, si todavía no existe.
2. Confirmar el AWS account ID de destino y región `us-east-1`.
3. Confirmar el hosted zone ID público de `roadmap2u.com` sin modificar registros.
4. Designar a un operador con permisos acotados para el bootstrap inicial.
5. Revisar las plantillas sintetizadas y políticas IAM antes de aplicarlas.

El proveedor OIDC existente de la cuenta, con issuer `https://token.actions.githubusercontent.com` y audience `sts.amazonaws.com`, se reutiliza: este rollout no lo crea, reemplaza ni elimina. `Roadmap-CiBootstrap` usa `BootstraplessSynthesizer`, se sintetiza a una plantilla revisable y se aplica directamente mediante CloudFormation por el operador temporal. Así no depende del `CDKToolkit` compartido ni de sus permisos administrativos. Después se crean tres toolkits personalizados para las cargas de `dev`, `test` y `prod` a partir de plantillas derivadas del bootstrap canónico v33, fijadas en el repositorio y revisadas; actualizar CDK exige regenerar y revisar explícitamente esas plantillas.

Los toolkits de stage usan calificadores y nombres distintos:

| Stage | Qualifier | Toolkit stack |
|---|---|---|
| `dev` | `rmap2udev` | `RoadMap2U-CDK-dev` |
| `test` | `rmap2utst` | `RoadMap2U-CDK-test` |
| `prod` | `rmap2uprd` | `RoadMap2U-CDK-prod` |

Esto separa nombres de roles, buckets y assets y evita que un rol OIDC asuma los roles bootstrap de otro stage. No es por sí solo una frontera de permisos: en una misma cuenta, el alcance efectivo lo determina la política del `CloudFormationExecutionRole`. `AWS_DEPLOY_ENABLED` y `AWS_ROLLBACK_ENABLED` deben permanecer en `false` hasta que exista una managed policy revisada y de mínimo privilegio para cada stage. Nunca uses `AdministratorAccess` como policy de ejecución de estos toolkits.

Cada `CloudFormationExecutionRole` adjunta las cinco policies de workload `cfn-core`, `cfn-api`, `cfn-data`, `cfn-edge` y `cfn-observability`; la sexta managed policy del stage es la `runtime-boundary` y nunca se adjunta como permiso de ejecución. `cfn-observability` queda separada, acotada a `roadmap-commercial-alerts-<stage>` y `roadmap-commercial-<stage>-*`, y no concede `sns:Publish`, `cloudwatch:PutMetricData` ni un `Resource: "*"`.

Cada toolkit también posee el log group `/aws/apigateway/roadmap-api-<stage>`, su retención de 7/14/30 días y una `ResourcePolicyDocument` limitada al principal `delivery.logs.amazonaws.com`, a la cuenta y al ARN exacto del log group. El toolkit exporta el nombre y el backend construye desde él un único ARN con sufijo `:*`. Así, el operador temporal MFA realiza `logs:PutResourcePolicy` durante el bootstrap, mientras los `CloudFormationExecutionRole` ordinarios sólo conservan las autorizaciones regionales de entrega y lectura que API Gateway necesita. Además, `apigateway:Request/AccessLoggingDestination` fija cada `CreateStage`/`UpdateStage` al log group del mismo ambiente; un stack `dev` no puede reescribir la política ni redirigir los access logs hacia `test` o `prod`.

## GitHub Environments

Crea `dev`, `test` y `prod` en ambos repositorios:

- `Toydrum/roadmap2u-backend`;
- `Toydrum/RoadMap2U`.

Configura `test` y `prod` como ambientes protegidos. `prod` debe requerir aprobación manual. En los environments `dev`, `test` y `prod` de **ambos** repositorios, configura `Deployment branches and tags` para permitir únicamente la rama `main`; esto es obligatorio antes de activar el gate porque el subject OIDC identifica el environment, no la rama que contiene el workflow. No permitas que un pull request de un fork acceda a un environment de despliegue.

En el repositorio backend crea además `prod-dns-cutover`. Es un segundo environment, exclusivo del job que muta apex/`www`, y debe requerir una aprobación posterior a la generación del plan. Limítalo a `main`, configura revisores autorizados para DNS y evita que el operador que lanzó el workflow pueda saltarse la revisión cuando la configuración de GitHub lo permita. El job `plan` usa `prod`; el job `apply` usa `prod-dns-cutover`.

### Variables del repositorio y por environment

`AWS_DEPLOY_ENABLED=false` y `AWS_ROLLBACK_ENABLED=false` son gates **de repositorio** en ambos repositorios. Son mutuamente excluyentes: deploy/promoción exige literalmente `AWS_DEPLOY_ENABLED=true` y `AWS_ROLLBACK_ENABLED=false`; rollback backend exige literalmente `AWS_DEPLOY_ENABLED=false` y `AWS_ROLLBACK_ENABLED=true`. Un valor ausente, vacío, mal escrito o cualquier otra combinación cierra el job antes de obtener credenciales. `DNS_CUTOVER_ENABLED=false` es un gate adicional solo del backend. Todos se evalúan antes de iniciar el job y no deben depender de variables definidas únicamente dentro del environment.

Los demás valores pueden variar entre repositorios porque cada uno usa un rol distinto. Los workflows consumen estas variables en cada environment:

| Variable | Ejemplo/formato | Regla |
|---|---|---|
| `AWS_ACCOUNT_ID` | 12 dígitos | misma cuenta aprobada para ese stage |
| `HOSTED_ZONE_ID` | ID de la zona pública | variable, no secret |
| `AWS_ROLE_ARN` | `arn:aws:iam::<account>:role/<role>` | rol del repo y stage exactos |

El frontend consume `AWS_ACCOUNT_ID` y `AWS_ROLE_ARN`; el ARN apunta al rol frontend del stage. El backend consume además `HOSTED_ZONE_ID` para synth/deploy. Los ARNs y IDs no son secretos; aun así, no deben hardcodearse porque pertenecen a una cuenta/ambiente concreto.

En cada environment backend crea el secret `ALARM_NOTIFICATION_EMAIL`. El workflow lo valida y enmascara antes del diff, lo pasa a ambos comandos CDK como parámetro CloudFormation `AlarmNotificationEmail` con `NoEcho` y se detiene hasta que exista exactamente una suscripción email confirmada. El valor no forma parte del contexto CDK ni de los templates; no lo copies a variables, logs o evidencia.

El environment backend `prod` recibe `DNS_PLAN_ROLE_ARN` desde el output `prodDnsPlanRoleArn`; ese rol solo puede leer la zona, distribución, certificado, marcadores y respaldo necesarios para generar el plan. El environment separado `prod-dns-cutover` recibe `DNS_CUTOVER_ROLE_ARN` desde `prodDnsCutoverRoleArn`; solo este rol puede mutar el apex/`www` y escribir el respaldo SSM tras la segunda aprobación. Ambos environments reciben `AWS_ACCOUNT_ID` y `HOSTED_ZONE_ID`. Mantén el gate de repositorio `DNS_CUTOVER_ENABLED` en `false` hasta la ventana formal de corte.

No crear `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY` ni `AWS_SESSION_TOKEN` como Secrets o Variables. Si ya existen credenciales permanentes heredadas, retíralas únicamente mediante un cambio administrado después de confirmar que ningún job las consume.

## Política de confianza OIDC

El provider usa:

- issuer: `https://token.actions.githubusercontent.com`;
- audience: `sts.amazonaws.com`.

Cada rol restringe `sub` a IDs inmutables de owner/repositorio y al GitHub Environment esperado. Los patrones canónicos son:

```text
repo:Toydrum@61118847/roadmap2u-backend@1307128632:environment:<stage>
repo:Toydrum@61118847/RoadMap2U@741787733:environment:<stage>
```

Sustituye `<stage>` únicamente por `dev`, `test` o `prod`; para el rol DNS de aplicación se usa `prod-dns-cutover`. No regreses a subjects basados solo en nombres: un rename o un namespace reciclado no debe heredar confianza.

GitHub debe emitir ese formato de forma explícita en **ambos** repositorios. Haz este cambio únicamente después de crear las trust policies AWS y los environments, pero antes de cualquier preflight. La versión de API es parte del control: versiones antiguas no reconocen `use_immutable_subject`.

```bash
for repo in Toydrum/roadmap2u-backend Toydrum/RoadMap2U; do
  gh api --method PUT \
    -H 'Accept: application/vnd.github+json' \
    -H 'X-GitHub-Api-Version: 2026-03-10' \
    "repos/${repo}/actions/oidc/customization/sub" \
    --input - <<'JSON'
{"use_default":true,"use_immutable_subject":true}
JSON
done
```

Verifica los dos repositorios antes de solicitar un token:

```bash
gh api -H 'X-GitHub-Api-Version: 2026-03-10' \
  repos/Toydrum/roadmap2u-backend/actions/oidc/customization/sub
gh api -H 'X-GitHub-Api-Version: 2026-03-10' \
  repos/Toydrum/RoadMap2U/actions/oidc/customization/sub
```

Cada respuesta debe contener `"use_immutable_subject":true`. `sub_claim_prefix` debe ser exactamente `repo:Toydrum@61118847/roadmap2u-backend@1307128632` para backend y `repo:Toydrum@61118847/RoadMap2U@741787733` para frontend. Si cualquiera difiere, no ejecutes el preflight ni habilites un gate de despliegue.

No uses un comodín como `repo:Toydrum/*:*`. El rol backend puede asumir únicamente los roles bootstrap necesarios de su qualifier; no puede asumir directamente el `CloudFormationExecutionRole`. Además lee estado/configuración y retención de logs, y crea su `backend-release-manifests/*` inmutable antes de escribir `backend-releases/*`/`backend-release-sha`. El rol frontend puede leer el pointer y manifiesto backend, escribir únicamente sus marcadores frontend, publicar en su bucket e invalidar la distribución etiquetada del stage. Ninguno de los seis roles normales ni el rol de planificación puede editar aliases apex/`www`: esa capacidad vive exclusivamente en el rol de cutover, detrás de dos gates y dos aprobaciones.

Las trust policies DNS deben permanecer separadas: `roadmap2u-prod-dns-plan` acepta **únicamente** el subject backend `environment:prod`, mientras `roadmap2u-prod-dns-cutover` acepta **únicamente** `environment:prod-dns-cutover`. La policy del primer rol incluye `acm:DescribeCertificate` para validar el certificado productivo referenciado por CloudFront, pero no permisos de mutación; la del segundo contiene la mutación Route 53 y la escritura del respaldo, pero no la lectura de planificación. Si falta cualquiera de los dos roles o permisos, el workflow debe detenerse y el gate no debe habilitarse.

## Permisos del workflow

Un job de deploy que lee el repositorio requiere:

```yaml
permissions:
  contents: read
  id-token: write
```

`id-token: write` permite solicitar el token; no concede por sí solo acceso AWS. La combinación del subject, environment protegido, audience, rol y política IAM determina el alcance efectivo.

El preflight `.github/workflows/oidc-preflight.yml` es más estricto: declara `permissions: {}` globalmente, concede únicamente `id-token: write` al job, no hace checkout y su única llamada AWS es `sts:GetCallerIdentity`. Sirve para comprobar subject, environment, role y cuenta sin disponer de APIs de escritura.

El job DNS `apply` añade únicamente `actions: read` a su `GITHUB_TOKEN` para descargar por ID el ZIP del plan y comparar de forma fail-closed su digest; no obtiene permisos GitHub de escritura.

Evita `pull_request_target` en cualquier workflow con permisos AWS. Los PR normales deben ejecutar CI sin asumir un rol de despliegue ni escribir en AWS.

## Secuencia de bootstrap controlada

1. Mantener `AWS_DEPLOY_ENABLED=false` y `AWS_ROLLBACK_ENABLED=false` en ambos repositorios.
2. Autenticarse en AWS con la identidad administrativa aprobada y verificar account/region mediante una llamada de solo lectura.
3. Confirmar que el proveedor OIDC existente tiene exactamente el issuer/audience aprobados; abortar si falta o difiere, sin recrearlo automáticamente.
4. Sintetizar `Roadmap-CiBootstrap` con `BootstraplessSynthesizer`, revisar la plantilla y aplicarla directamente por CloudFormation con el rol bootstrap temporal. Habilitar termination protection y capturar sus outputs.
5. Revisar las tres policies de ejecución CloudFormation y las tres plantillas bootstrap personalizadas versionadas, una por stage. Deben cubrir solo recursos RoadMap2U, imponer el execution role/boundary correctos y no incluir `AdministratorAccess`.
6. Antes de la primera actualización, consultar los nombres exactos `/aws/apigateway/roadmap-api-dev|test|prod`. Si alguno ya existe y `cloudformation describe-stack-resources` no lo atribuye a su stack `RoadMap2U-CDK-<stage>`, abortar: CloudFormation no adopta un log group huérfano de forma automática.
7. Aplicar mediante CloudFormation los tres toolkits con nombres/calificadores únicos y termination protection. Los comandos CDK equivalentes que originan las plantillas se conservan solo como referencia reproducible; nunca se ejecutan con el toolkit compartido:

   ```powershell
   npx cdk bootstrap aws://<ACCOUNT_ID>/us-east-1 --toolkit-stack-name RoadMap2U-CDK-dev --qualifier rmap2udev --cloudformation-execution-policies <ARN_POLICY_DEV> --termination-protection
   npx cdk bootstrap aws://<ACCOUNT_ID>/us-east-1 --toolkit-stack-name RoadMap2U-CDK-test --qualifier rmap2utst --cloudformation-execution-policies <ARN_POLICY_TEST> --termination-protection
   npx cdk bootstrap aws://<ACCOUNT_ID>/us-east-1 --toolkit-stack-name RoadMap2U-CDK-prod --qualifier rmap2uprd --cloudformation-execution-policies <ARN_POLICY_PROD> --termination-protection
   ```

8. Confirmar los tres parámetros `/cdk-bootstrap/rmap2udev|rmap2utst|rmap2uprd/version`, los tres exports `RoadMap2U-<stage>-ApiAccessLogGroupName` y que cada toolkit referencia exclusivamente su policy/boundary aprobados.
9. Copiar los seis ARNs frontend/backend a sus GitHub Environments; copiar `prodDnsPlanRoleArn` como `DNS_PLAN_ROLE_ARN` de `prod` y `prodDnsCutoverRoleArn` como `DNS_CUTOVER_ROLE_ARN` de `prod-dns-cutover`. Copiar también en ambos el mismo account ID y hosted zone ID aprobados.
10. Activar `use_immutable_subject:true` en ambos repositorios con la API `2026-03-10` y verificar los dos `sub_claim_prefix` exactos.
11. Ejecutar los ocho preflights de identidad —cinco backend y tres frontend— que solo hacen `sts:GetCallerIdentity`, y comprobar repo/environment/account.
12. Eliminar inmediatamente el operador temporal y su prefijo de plantillas con `./scripts/aws-bootstrap.ps1 -Phase delete-operator -AdminProfile <ADMIN_PROFILE>`. Confirmar que `RoadMap2U-BootstrapOperator` ya no aparece en `describe-stacks`; no habilitar ningún gate mientras ese stack exista.
13. Ejecutar CI/synth y revisar diff sin deploy.
14. Habilitar primero `dev`; mantener `test` y `prod` cerrados hasta validar los criterios de promoción.

Los pasos 3 a 12 se ejecutan únicamente en la ventana aprobada, con evidencia de cada cambio. El operador temporal existe sólo entre los pasos 4 y 12; preparar o revisar esta guía no autoriza ejecutarlos fuera de esa ventana.

Los workflows del backend son:

- `.github/workflows/ci.yml`: validación sin escritura;
- `.github/workflows/deploy.yml`: deploy/promoción/rollback con SHA inmutable, gates excluyentes y un solo job protegido por stage;
- `.github/workflows/oidc-preflight.yml`: preflight manual de identidad sin checkout ni APIs AWS de escritura;
- `.github/workflows/dns-cutover.yml`: operación futura con plan inmutable en `prod` y apply exacto en `prod-dns-cutover`; ambos jobs vuelven a comprobar los dos gates.

En el frontend, `.github/workflows/ci.yml` valida, `deploy-aws-dev.yml` publica dev, `promote-aws.yml` promueve a test/prod y `rollback-aws.yml` republica un SHA bueno. El workflow legacy `deploy.yml` permanece únicamente manual durante la transición. Todos los workflows AWS frontend comparten región fija `us-east-1`; el gate es de repositorio y cada environment aporta `AWS_ACCOUNT_ID`/`AWS_ROLE_ARN`.

## Comprobaciones antes de activar deploy

- El repo backend es público, conserva `LICENSE` MIT y tiene branch protection en `main`.
- Los environments `dev`, `test` y `prod` de ambos repositorios permiten deployment únicamente desde `main`; `prod-dns-cutover` también está limitado a `main`.
- Los seis roles de deploy usan subjects OIDC inmutables de owner ID/repository ID/stage exactos; el rol DNS de planificación admite únicamente `prod` y el rol de cutover únicamente `prod-dns-cutover`.
- Los tres toolkits de stage existen con sus qualifiers exactos y cada `CloudFormationExecutionRole` tiene una policy revisada para ese stage, nunca `AdministratorAccess`.
- Cada job reporta el account ID y la región esperados antes de cualquier diff/deploy.
- `HOSTED_ZONE_ID` corresponde a la zona pública de `roadmap2u.com`.
- No hay access keys en Secrets, Variables, archivos o historial reciente.
- `prod` requiere aprobación y solo acepta un SHA exitoso de `test`.
- `deploy.yml` tiene un solo job asociado al environment del stage, por lo que un deploy productivo no introduce una segunda aprobación oculta.
- El preflight OIDC pasó en cada par repositorio/stage y solo ejecutó `sts:GetCallerIdentity`.
- La plantilla productiva no contiene recursos Route 53 para apex/`www`.
- Los registros actuales siguen siendo A `162.241.62.201` y CNAME `www → roadmap2u.com`.
- `prod-dns-cutover` requiere aprobación independiente, contiene las tres variables DNS correctas y el apply descarga por artifact ID el plan de su misma ejecución.

## Rotación y revocación

OIDC elimina la rotación de access keys, pero los permisos todavía deben revisarse. Para revocar CI, establece `AWS_DEPLOY_ENABLED=false` y `AWS_ROLLBACK_ENABLED=false`, y deshabilita o restringe la trust policy del rol. Si se compromete un workflow, bloquea los environments, revisa CloudTrail y reemplaza el workflow antes de restaurar confianza; no basta con cambiar una variable de ARN.
