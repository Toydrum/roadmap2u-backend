# Accesos Premium patrocinados

Este runbook cubre la emisión, entrega, consulta y revocación de códigos Premium para beta testers y para la cuenta del creador. Un código es una credencial portadora de un solo uso, no un token de administración: al canjearse crea un grant Premium en una cuenta adulta con correo verificado. La llave permanente del creador concede Premium sin vencimiento, pero no añade permisos administrativos.

Producción requiere una autorización explícita separada. Un deploy no habilita emisión ni canje: `accessCodeIssuanceEnabled` y `accessCodeRedemptionEnabled` permanecen apagados por defecto, y `premiumPaymentsEnabled` sigue forzado a `false`.

## Reglas operativas

- Usa únicamente el rol MFA `roadmap2u-<stage>-sponsored-access-operator` y la Function URL del mismo stage.
- Ejecuta primero el dry run y después repite exactamente el comando con `--apply`, `--confirm-stage` y el hash mostrado.
- Genera un `command-id` UUID v4 nuevo por mutación. Reutiliza el mismo ID sólo para recuperar el resultado idempotente de la misma solicitud; el plaintext no vuelve a mostrarse.
- Emite un código distinto por persona. No incluyas correo, nombre u otra PII en `--reason`; usa identificadores internos como `beta-01`.
- Copia el código directamente a un canal individual controlado. No lo guardes en Git, tickets, archivos de evidencia, gestores de tareas, URLs, capturas ni logs compartidos.
- La terminal revela el plaintext una sola vez. No redirijas la salida a un archivo y limpia cualquier transcript de terminal que lo haya capturado.
- Conserva sólo `issuanceId`, estado, vencimiento, reason no personal y evidencia sanitizada.

Los ejemplos usan placeholders deliberados. Sustituye `<stage>`, `<broker-url>`, `<profile>`, `<uuid>` y `<hash>`; nunca pegues un código real en el historial del shell.

## Emisión temporal

Sin opciones de duración, el grant dura 30 días y el código puede canjearse durante 7 días.

```powershell
npm run commercial:access -- issue-code `
  --stage <stage> `
  --url <broker-url> `
  --profile <profile> `
  --command-id <uuid> `
  --reason 'beta-01'
```

Revisa `stage` y el `confirmHash`. Después repite los mismos argumentos y agrega:

```text
--apply --confirm-stage <stage> --confirm-hash <hash>
```

Para una duración distinta, agrega `--duration-seconds <segundos>`; el rango permitido es de 1 día a 5 años. Para cambiar la ventana de canje, agrega `--redeem-window-seconds <segundos>`; el rango permitido es de 1 hora a 30 días.

## Acceso permanente del creador

Usa un código normal con doble confirmación de permanencia:

```powershell
npm run commercial:access -- issue-code `
  --stage <stage> `
  --url <broker-url> `
  --profile <profile> `
  --command-id <uuid> `
  --reason 'creator-premium' `
  --permanent `
  --confirm-permanent
```

Completa primero el dry run y luego aplica con stage y hash. Este código no debe compartirse con beta testers y no convierte la cuenta en administradora. Si después se necesita una consola creator/admin, debe diseñarse como una autorización separada.

## Consulta y recuperación

`metadata` nunca devuelve el plaintext. Úsalo para confirmar el estado de un `issuanceId`. También exige dry run y aplicación interactiva:

```powershell
npm run commercial:access -- metadata `
  --stage <stage> `
  --url <broker-url> `
  --profile <profile> `
  --issuance-id <uuid>
```

Si una emisión se confirmó pero el código no se copió, no intentes recuperarlo: revoca el código pendiente y emite otro con un `command-id` nuevo.

## Revocación

Para invalidar un código aún no canjeado:

```powershell
npm run commercial:access -- revoke-code `
  --stage <stage> `
  --url <broker-url> `
  --profile <profile> `
  --command-id <uuid-nuevo> `
  --issuance-id <uuid-emision> `
  --reason 'delivery-channel-compromised'
```

Para retirar Premium después del canje usa `revoke-grant` con los mismos argumentos. Para ampliar un grant temporal usa `extend-grant` y agrega `--new-expires-at <epoch-ms>`; la nueva fecha debe ser posterior a la actual y no superar cinco años desde el inicio original.

Cada mutación sigue el mismo ciclo dry run y `--apply --confirm-stage <stage> --confirm-hash <hash>`.

## Secuencia recomendada para la cohorte inicial de producción

1. Despliega y verifica producción con emisión y canje apagados.
2. Con autorización explícita de producción, habilita primero `accessCodeRedemptionEnabled=true` usando el broker de configuración y su rol MFA.
3. Habilita `accessCodeIssuanceEnabled=true` sólo durante la ventana de emisión.
4. Emite cuatro códigos temporales separados para beta testers y un código permanente separado para el creador.
5. Deshabilita inmediatamente `accessCodeIssuanceEnabled`; deja canje activo sólo durante la ventana necesaria.
6. Entrega cada código individualmente y verifica con `metadata` que cada canje cambie a `redeemed`.
7. Revoca cualquier código cuya entrega sea dudosa y conserva evidencia sin plaintext.

El cambio de flags usa `npm run commercial:set`. Lee primero la revisión autoritativa, ejecuta el dry run con `--expected-revision`, `--access-code-issuance-enabled` o `--access-code-redemption-enabled`, y aplica únicamente con el hash resultante. No actives pagos en este flujo.

## Rotación del secreto HMAC

La rotación no se realiza con el rol de emisión. Debe ejecutarse como un cambio controlado de Secrets Manager y despliegue:

1. Añade una versión nueva al JSON del secreto, conserva todas las versiones aún referenciadas por códigos pendientes y cambia `activeVersion` a la nueva versión.
2. Verifica que una emisión nueva guarde la versión nueva y que un código pendiente de la versión anterior todavía pueda validarse.
3. Revoca o deja vencer todos los códigos pendientes de una versión anterior antes de retirarla.
4. Si hubo exposición, apaga emisión y canje, revoca códigos pendientes, rota el secreto, redespliega y reactiva primero en `dev` y `test`.

Nunca reemplaces el JSON dejando sólo la versión nueva mientras existan códigos pendientes: cada registro guarda `secretKeyVersion` y necesita esa clave para validar el HMAC.

## Verificación y respuesta

- El código válido se canjea una sola vez; un retry de la misma cuenta es idempotente y otra cuenta recibe un error genérico.
- Los errores inexistente, vencido, revocado, ya usado por otra cuenta o MAC inválido no revelan cuál condición ocurrió.
- Tras cinco intentos por cuenta y hora, el endpoint responde rate limit; API Gateway añade throttling global.
- Logs y métricas no deben contener plaintext, JWT, correo ni PII. Ante una sospecha, detén emisión/canje y trata el código como comprometido.
- Confirma que las transacciones actualizaron CODE, GRANT, ACCESS y auditoría de forma consistente antes de cerrar el incidente.
