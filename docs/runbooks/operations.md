# Operaciones MFA: smoke cleanup y break-glass

Este runbook cubre las dos operaciones humanas que no pertenecen al CI/CD normal. Ambas exigen un código MFA nuevo, una confirmación literal y la identidad `Hector-admin`. No uses estos scripts para despliegues ni para producción cotidiana.

## Reglas comunes

Antes de empezar:

1. Deja `AWS_DEPLOY_ENABLED=false`, `AWS_ROLLBACK_ENABLED=false` y, en backend, `DNS_CUTOVER_ENABLED=false`.
2. Comprueba que el perfil `zoolanding` resuelve a la cuenta `765932874577` y que la región es `us-east-1`.
3. Trabaja desde un checkout limpio del SHA desplegado y conserva la salida de la terminal como evidencia.
4. No reutilices un código MFA ni amplíes manualmente las policies de los roles operativos.

## Eliminar un usuario de smoke

Los usuarios de prueba eliminables deben tener un username `smoke_` seguido de 1 a 14 caracteres `a-z`, `0-9` o `_`. Usa una cuenta diferente por stage y nunca reutilices el email de una persona real.

Después de signup, confirmación, login y `GET /v1/me` exitoso, captura:

- `UserPoolId` desde `/roadmap2u/<stage>/user-pool-id`;
- el username exacto;
- el UUID `sub` que devuelve la sesión autenticada/Cognito.

Ejemplo:

```powershell
.\scripts\aws-smoke-cleanup.ps1 `
  -Stage dev `
  -UserPoolId us-east-1_XXXXXXXXX `
  -Username smoke_dev_01 `
  -UserId 00000000-0000-4000-8000-000000000000 `
  -Confirmation 'DELETE SMOKE dev smoke_dev_01' `
  -MfaCode 123456
```

El script asume el rol MFA exclusivo del stage, vuelve a leer el User Pool ID desde SSM, valida que Cognito asocie exactamente username y `sub`, consulta de forma paginada la partición `USER#<sub>`, borra sus claves solo con `DeleteItem` y elimina la reserva `UNIQ#USERNAME#<username>` únicamente si pertenece al mismo `sub` o ya está ausente. Cognito se elimina al final. Cada rol queda limitado a un solo pool/tabla etiquetado y no puede crear tablas, escribir items ni desplegar stacks.

Limitación conocida: IAM no ofrece una condición para restringir `AdminDeleteUser` a usernames con prefijo ni `DeleteItem` a un valor de partition key. Por eso las guardas por usuario viven en el script y pueden omitirse si `Hector-admin` usa directamente las credenciales asumidas. El MFA, el aislamiento por stage y el hecho de que ese principal ya es el administrador de la cuenta reducen el riesgo de exposición, pero no sustituyen enforcement server-side. Antes de delegar esta operación a otra identidad o de tener usuarios reales, reemplaza el acceso directo por un broker Lambda que valide el prefijo, username, `sub` y reserva y concede al operador únicamente `lambda:InvokeFunction`.

Si falla antes de borrar Cognito, conserva los mismos parámetros y repite con un MFA nuevo; las eliminaciones DynamoDB y la reserva son reanudables. Si Cognito ya responde `UserNotFoundException`, no pruebes otro `sub`: verifica primero la partición y la reserva con una sesión administrativa controlada y documenta el estado antes de cualquier limpieza manual.

Al terminar, confirma:

- Cognito responde `UserNotFoundException` para el username;
- la consulta `pk = USER#<sub>` devuelve cero items;
- la reserva `UNIQ#USERNAME#<username>` no existe;
- no cambió ningún otro usuario ni stage.

## Destruir dev o test por break-glass

Esta ruta existe solo para `dev` y `test`; producción, los toolkits y `Roadmap-CiBootstrap` están fuera de su policy. El script vacía todas las versiones y delete markers del bucket en lotes de hasta 1000, después elimina Hosting y Backend en ese orden.

```powershell
.\scripts\aws-break-glass.ps1 `
  -Stage dev `
  -Confirmation 'DESTROY dev' `
  -MfaCode 123456
```

El procedimiento es reanudable: un bucket o stack ya ausente se omite. Si la sesión de una hora expira o CloudFormation queda en progreso, espera a que el estado se estabilice y ejecuta de nuevo el mismo comando con un MFA nuevo. No cambies el stage ni intentes borrar recursos restantes con el perfil administrador mientras CloudFormation siga operando.

La operación termina correctamente cuando ambos stacks no existen y el bucket `roadmap2u-<stage>-765932874577` tampoco existe. Conserva eventos `DELETE_FAILED`, errores de objetos y el último estado; corrige la causa concreta y reanuda, sin desactivar termination protection de los toolkits ni ampliar el rol.
