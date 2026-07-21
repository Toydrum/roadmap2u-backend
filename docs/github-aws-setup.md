# Configuración de GitHub Actions con AWS OIDC

## Propósito

GitHub Actions debe obtener credenciales temporales mediante OpenID Connect. No se crean ni almacenan access keys de IAM en GitHub. La configuración separa:

- repositorio frontend y repositorio backend;
- ambientes `dev`, `test` y `prod`;
- permisos de validación frente a permisos de deploy.

Esta guía prepara una operación futura. **No autoriza ejecutar bootstrap o deploy como parte de la creación del repositorio.**

## Prerrequisitos administrativos

1. Reautenticar GitHub CLI y crear el repositorio público `Toydrum/roadmap2u-backend` con licencia MIT, si todavía no existe.
2. Confirmar el AWS account ID de destino y región `us-east-1`.
3. Confirmar el hosted zone ID público de `roadmap2u.com` sin modificar registros.
4. Designar a un operador con permisos acotados para el bootstrap inicial.
5. Revisar las plantillas sintetizadas y políticas IAM antes de aplicarlas.

El primer bootstrap no puede asumir un rol que aún no existe. Un administrador autorizado debe crear primero el toolkit CDK predeterminado que usará exclusivamente `Roadmap-CiBootstrap`, desplegar ese stack de confianza y luego crear tres toolkits adicionales para las cargas de `dev`, `test` y `prod`. Después, los workflows usan exclusivamente los roles resultantes.

Los toolkits de stage usan calificadores y nombres distintos:

| Stage | Qualifier | Toolkit stack |
|---|---|---|
| `dev` | `rmap2udev` | `RoadMap2U-CDK-dev` |
| `test` | `rmap2utst` | `RoadMap2U-CDK-test` |
| `prod` | `rmap2uprd` | `RoadMap2U-CDK-prod` |

Esto separa nombres de roles, buckets y assets y evita que un rol OIDC asuma los roles bootstrap de otro stage. No es por sí solo una frontera de permisos: en una misma cuenta, el alcance efectivo lo determina la política del `CloudFormationExecutionRole`. `AWS_DEPLOY_ENABLED` debe permanecer en `false` hasta que exista una managed policy revisada y de mínimo privilegio para cada stage. Nunca uses `AdministratorAccess` como `--cloudformation-execution-policies` para estos toolkits.

## GitHub Environments

Crea `dev`, `test` y `prod` en ambos repositorios:

- `Toydrum/roadmap2u-backend`;
- `Toydrum/RoadMap2U`.

Configura `test` y `prod` como ambientes protegidos. `prod` debe requerir aprobación manual. En los environments `dev`, `test` y `prod` de **ambos** repositorios, configura `Deployment branches and tags` para permitir únicamente la rama `main`; esto es obligatorio antes de activar el gate porque el subject OIDC identifica el environment, no la rama que contiene el workflow. No permitas que un pull request de un fork acceda a un environment de despliegue.

En el repositorio backend crea además `prod-dns-cutover`. Es un segundo environment, exclusivo del job que muta apex/`www`, y debe requerir una aprobación posterior a la generación del plan. Limítalo a `main`, configura revisores autorizados para DNS y evita que el operador que lanzó el workflow pueda saltarse la revisión cuando la configuración de GitHub lo permita. El job `plan` usa `prod`; el job `apply` usa `prod-dns-cutover`.

### Variables del repositorio y por environment

`AWS_DEPLOY_ENABLED=false` es un gate **de repositorio** en ambos repositorios. `DNS_CUTOVER_ENABLED=false` es un segundo gate de repositorio solo en el backend. Ambos se evalúan antes de iniciar el job y, por tanto, no deben depender de variables definidas únicamente dentro del environment. Se cambian a `true` solo durante el rollout o la ventana de corte aprobados.

Los demás valores pueden variar entre repositorios porque cada uno usa un rol distinto. Los workflows consumen estas variables en cada environment:

| Variable | Ejemplo/formato | Regla |
|---|---|---|
| `AWS_ACCOUNT_ID` | 12 dígitos | misma cuenta aprobada para ese stage |
| `HOSTED_ZONE_ID` | ID de la zona pública | variable, no secret |
| `AWS_ROLE_ARN` | `arn:aws:iam::<account>:role/<role>` | rol del repo y stage exactos |

El frontend consume `AWS_ACCOUNT_ID` y `AWS_ROLE_ARN`; el ARN apunta al rol frontend del stage. El backend consume además `HOSTED_ZONE_ID` para synth/deploy. Los ARNs y IDs no son secretos; aun así, no deben hardcodearse porque pertenecen a una cuenta/ambiente concreto.

El environment backend `prod` recibe `DNS_PLAN_ROLE_ARN` desde el output `prodDnsPlanRoleArn`; ese rol solo puede leer la zona, distribución, certificado, marcadores y respaldo necesarios para generar el plan. El environment separado `prod-dns-cutover` recibe `DNS_CUTOVER_ROLE_ARN` desde `prodDnsCutoverRoleArn`; solo este rol puede mutar el apex/`www` y escribir el respaldo SSM tras la segunda aprobación. Ambos environments reciben `AWS_ACCOUNT_ID` y `HOSTED_ZONE_ID`. Mantén el gate de repositorio `DNS_CUTOVER_ENABLED` en `false` hasta la ventana formal de corte.

No crear `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY` ni `AWS_SESSION_TOKEN` como Secrets o Variables. Si ya existen credenciales permanentes heredadas, retíralas únicamente mediante un cambio administrado después de confirmar que ningún job las consume.

## Política de confianza OIDC

El provider usa:

- issuer: `https://token.actions.githubusercontent.com`;
- audience: `sts.amazonaws.com`.

Cada rol restringe `sub` al repositorio y GitHub Environment esperados. Ejemplos de subjects:

```text
repo:Toydrum/roadmap2u-backend:environment:dev
repo:Toydrum/roadmap2u-backend:environment:test
repo:Toydrum/roadmap2u-backend:environment:prod
repo:Toydrum/roadmap2u-backend:environment:prod-dns-cutover
repo:Toydrum/RoadMap2U:environment:dev
repo:Toydrum/RoadMap2U:environment:test
repo:Toydrum/RoadMap2U:environment:prod
```

No uses un comodín como `repo:Toydrum/*:*`. El rol de backend puede asumir únicamente los roles `deploy`, `file-publishing`, `image-publishing` y `lookup` del qualifier de su stage; no puede asumir directamente el `CloudFormationExecutionRole`. Además, puede leer estado/configuración y escribir sus propios marcadores. El rol frontend se limita a leer su configuración SSM, escribir únicamente sus marcadores `frontend-releases/*`/`frontend-release-sha`, publicar en su bucket e invalidar la distribución etiquetada para su stage. Ninguno de los seis roles normales ni el séptimo rol de planificación puede editar los aliases apex/`www`: esa capacidad vive exclusivamente en el octavo rol de cutover y permanece detrás de dos gates y dos aprobaciones.

Las trust policies DNS deben permanecer separadas: `roadmap2u-prod-dns-plan` acepta **únicamente** el subject backend `environment:prod`, mientras `roadmap2u-prod-dns-cutover` acepta **únicamente** `environment:prod-dns-cutover`. La policy del primer rol incluye `acm:DescribeCertificate` para validar el certificado productivo referenciado por CloudFront, pero no permisos de mutación; la del segundo contiene la mutación Route 53 y la escritura del respaldo, pero no la lectura de planificación. Si falta cualquiera de los dos roles o permisos, el workflow debe detenerse y el gate no debe habilitarse.

## Permisos del workflow

Un job que asume el rol requiere:

```yaml
permissions:
  contents: read
  id-token: write
```

`id-token: write` permite solicitar el token; no concede por sí solo acceso AWS. La combinación del subject, environment protegido, audience, rol y política IAM determina el alcance efectivo.

Evita `pull_request_target` en cualquier workflow con permisos AWS. Los PR normales deben ejecutar CI sin asumir un rol de despliegue ni escribir en AWS.

## Secuencia de bootstrap (futura)

1. Mantener `AWS_DEPLOY_ENABLED=false` en ambos repositorios.
2. Autenticarse en AWS con la identidad administrativa aprobada y verificar account/region mediante una llamada de solo lectura.
3. Crear o actualizar el toolkit predeterminado para `Roadmap-CiBootstrap`, con termination protection. Sintetizar y revisar `Roadmap-CiBootstrap` usando cualquier `-c stage=dev|test|prod` (el contexto es obligatorio para la app, aunque este stack sea neutral) más `-c AWS_ACCOUNT_ID=... -c HOSTED_ZONE_ID=...`.
4. Desplegar `Roadmap-CiBootstrap` con aprobación explícita y capturar sus ocho outputs de roles OIDC.
5. Crear y revisar tres managed policies de ejecución de CloudFormation, una por stage. Deben cubrir solo los recursos RoadMap2U de ese stage, el hosted zone autorizado cuando corresponda y los roles IAM que genera el stack. Este repositorio no intenta fabricar una policy genérica permisiva.
6. Crear los tres toolkits de stage con nombres/calificadores únicos y su policy exacta; sustituye los placeholders y revisa el template antes de ejecutar:

   ```powershell
   npx cdk bootstrap aws://<ACCOUNT_ID>/us-east-1 --toolkit-stack-name RoadMap2U-CDK-dev --qualifier rmap2udev --cloudformation-execution-policies <ARN_POLICY_DEV> --termination-protection
   npx cdk bootstrap aws://<ACCOUNT_ID>/us-east-1 --toolkit-stack-name RoadMap2U-CDK-test --qualifier rmap2utst --cloudformation-execution-policies <ARN_POLICY_TEST> --termination-protection
   npx cdk bootstrap aws://<ACCOUNT_ID>/us-east-1 --toolkit-stack-name RoadMap2U-CDK-prod --qualifier rmap2uprd --cloudformation-execution-policies <ARN_POLICY_PROD> --termination-protection
   ```

7. Confirmar los cuatro parámetros de versión bootstrap: el predeterminado y `/cdk-bootstrap/rmap2udev|rmap2utst|rmap2uprd/version`.
8. Copiar los seis ARNs frontend/backend a sus GitHub Environments; copiar `prodDnsPlanRoleArn` como `DNS_PLAN_ROLE_ARN` de `prod` y `prodDnsCutoverRoleArn` como `DNS_CUTOVER_ROLE_ARN` de `prod-dns-cutover`. Copiar también en ambos el mismo account ID y hosted zone ID aprobados.
9. Ejecutar un job de identidad de mínimo alcance que haga únicamente `sts:GetCallerIdentity` y comprobar repo/stage/account.
10. Ejecutar CI/synth y revisar diff sin deploy.
11. Habilitar primero `dev`; mantener `test` y `prod` cerrados hasta validar los criterios de promoción.

Los pasos 3 a 9 mutan AWS o GitHub y **no forman parte de esta entrega**.

Los workflows del backend son:

- `.github/workflows/ci.yml`: validación sin escritura;
- `.github/workflows/deploy.yml`: deploy/promoción con environment y gate;
- `.github/workflows/dns-cutover.yml`: operación futura con plan inmutable en `prod` y apply exacto en `prod-dns-cutover`; ambos jobs vuelven a comprobar los dos gates.

En el frontend, `.github/workflows/ci.yml` valida, `deploy-aws-dev.yml` publica dev, `promote-aws.yml` promueve a test/prod y `rollback-aws.yml` republica un SHA bueno. El workflow legacy `deploy.yml` permanece únicamente manual durante la transición. Todos los workflows AWS frontend comparten región fija `us-east-1`; el gate es de repositorio y cada environment aporta `AWS_ACCOUNT_ID`/`AWS_ROLE_ARN`.

## Comprobaciones antes de activar deploy

- El repo backend es público, conserva `LICENSE` MIT y tiene branch protection en `main`.
- Los environments `dev`, `test` y `prod` de ambos repositorios permiten deployment únicamente desde `main`; `prod-dns-cutover` también está limitado a `main`.
- Los seis roles de deploy usan subjects OIDC de repo/stage exactos; el rol DNS de planificación admite únicamente `prod` y el rol de cutover admite únicamente `prod-dns-cutover`.
- Los tres toolkits de stage existen con sus qualifiers exactos y cada `CloudFormationExecutionRole` tiene una policy revisada para ese stage, nunca `AdministratorAccess`.
- Cada job reporta el account ID y la región esperados antes de cualquier diff/deploy.
- `HOSTED_ZONE_ID` corresponde a la zona pública de `roadmap2u.com`.
- No hay access keys en Secrets, Variables, archivos o historial reciente.
- `prod` requiere aprobación y solo acepta un SHA exitoso de `test`.
- La plantilla productiva no contiene recursos Route 53 para apex/`www`.
- Los registros actuales siguen siendo A `162.241.62.201` y CNAME `www → roadmap2u.com`.
- `prod-dns-cutover` requiere aprobación independiente, contiene las tres variables DNS correctas y el apply descarga por artifact ID el plan de su misma ejecución.

## Rotación y revocación

OIDC elimina la rotación de access keys, pero los permisos todavía deben revisarse. Para revocar CI, establece `AWS_DEPLOY_ENABLED=false` y deshabilita o restringe la trust policy del rol. Si se compromete un workflow, bloquea los environments, revisa CloudTrail y reemplaza el workflow antes de restaurar confianza; no basta con cambiar una variable de ARN.
