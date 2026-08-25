# Runbook de alertas comerciales

Este runbook cubre la instalación y la prueba del canal de alertas de cada stage. La implementación local no envía correos y no completa GATE-100: un `cdk synth` crea el topic, las alarmas y una suscripción condicional desactivada por el valor vacío predeterminado, sin endpoint literal ni suscripción activa.

## Propiedad y configuración

El owner operativo mantiene un secreto de GitHub Environment llamado `ALARM_NOTIFICATION_EMAIL` en `dev`, `test` y `prod`. El workflow oficial lo valida y enmascara antes de `cdk diff` y `cdk deploy`, y lo entrega sólo como parámetro CloudFormation `AlarmNotificationEmail` con `NoEcho`; no se incorpora al contexto CDK, al template ni a `cdk.out`. Un despliegue oficial falla si falta o si su formato no es válido.

Cada stage crea el topic `roadmap-commercial-alerts-${stage}` con transporte TLS obligatorio, una sola suscripción email cuando se proporciona el secreto y este inventario deliberadamente acotado:

| Stage | Alarm-metrics | Señales |
| --- | ---: | --- |
| `dev` | 2 | API 5xx y la alarma sintética |
| `test` | 1 | alarma sintética |
| `prod` | 8 | Lambda `Errors` de `pre-signup` y `post-confirmation`; API 5xx; edad de la cola de cierre; mensajes visibles en la DLQ; `ConfigurationDrift`; `CommercialConfigurationUnavailable`; y la alarma sintética |

Todas las alarmas usan periodos de cinco minutos, datos faltantes como `notBreaching` y el mismo topic como acción. La alarma sintética existe en los tres ambientes para que el workflow pueda comprobar el canal después de cada deploy; `test` no mantiene alertas de carga porque no recibe tráfico persistente.

No se crean alarmas `Duration`: el máximo de una sola invocación lenta resulta ruidoso y no representa por sí mismo una falla para el usuario. Las invocaciones que realmente fallan permanecen cubiertas en producción por Lambda `Errors`, API 5xx o los logs estructurados.

No se crean alarmas matemáticas de DynamoDB. La combinación anterior de `ThrottledRequests` y `SystemErrors` sumaba diez series `TableName` + `Operation` por alarma y por tabla, aunque el tráfico fuera mínimo. Los reintentos recuperados no requieren una alerta; si la operación finalmente falla, la falla queda en Lambda `Errors`, API 5xx o los logs estructurados. `TransactionConflict` tampoco mantiene una alarma fija: los conflictos esperados se responden y diagnostican mediante la respuesta de aplicación y sus logs. No sustituyas estas alarmas por métricas con `TableName` solamente, porque DynamoDB no publica así `ThrottledRequests` ni `SystemErrors`. Referencia operativa: [métricas y dimensiones de DynamoDB](https://docs.aws.amazon.com/amazondynamodb/latest/developerguide/metrics-dimensions.html).

HTTP API no publica una métrica nativa separada para 429: su [inventario oficial](https://docs.aws.amazon.com/apigateway/latest/developerguide/http-api-metrics.html) incluye `4xx`, `5xx`, `Count`, latencias y datos procesados. No se inventa `Throttles`, `ThrottleCount` ni `429`, y usar `4xx` mezclaría throttling con autenticación y otros errores de cliente. Queda como gap concreto añadir un productor sanitizado de conteo 429 desde access logs antes de afirmar cobertura específica de throttling HTTP.

## Confirmación y prueba sintética

1. La persona dueña del correo acepta la invitación SNS recibida. Mientras la suscripción muestre `PendingConfirmation`, el deploy oficial se detiene.
2. El workflow verifica exactamente una suscripción email confirmada mediante `ListSubscriptionsByTopic` sobre el topic del stage.
3. Después del deploy cambia temporalmente `roadmap-commercial-${stage}-synthetic` a `ALARM`, verifica el estado con `DescribeAlarms`, deja una ventana para la notificación y la devuelve a `OK`.
4. El owner confirma fuera de banda la recepción del correo y guarda sólo evidencia sanitizada. La ejecución local y el cambio de estado por sí solos no completan GATE-100.

El workflow y sus roles IAM no reciben `sns:Publish` ni `cloudwatch:PutMetricData`: el rol OIDC sólo puede listar las suscripciones del topic exacto y describir/cambiar el estado de la alarma sintética exacta. La policy de recurso del topic sí permite `sns:Publish` exclusivamente al principal `cloudwatch.amazonaws.com`, condicionado a la cuenta y al prefijo de alarmas del mismo stage; sin esa concesión CloudWatch no podría entregar alertas.

## Métricas EMF

`emitCommercialMetric` acepta únicamente métricas comerciales y stages allowlisted y no recibe request IDs, usuarios, correos, cuerpos ni códigos. El `CommercialConfigBroker` emite `CommercialConfigurationUnavailable` ante una respuesta 503.

`instrumentHandler` conserva los eventos estructurados `invocation.started`, `invocation.succeeded` e `invocation.failed`, pero no emite las series personalizadas `InvocationSucceeded` ni `InvocationFailed`: Lambda ya publica `Invocations` y `Errors` de forma nativa. Esto evita una serie por servicio y resultado en cada stage sin perder el rastro correlacionado en logs.

Los lectores runtime de flags de sincronización, capacidades sociales y acceso patrocinado inyectan `emitCommercialMetric(metric, stage)` en `CommercialFlagsResolver`. `ConfigurationDrift` conserva una alarma fija sólo en `prod`; en `dev` y `test` la métrica y los logs siguen disponibles para diagnóstico sin sumar otro costo mensual de alarma.

## Respuesta

- Lambda/API/SQS: revisar el recurso y el request ID en logs estructurados, sin copiar PII al incidente; para DynamoDB partir de la falla Lambda/API correlacionada.
- `CommercialConfigurationUnavailable`: mantener issuance, redemption y payments apagados; lectura y operaciones seguras siguen la matriz fail-closed.
- `ConfigurationDrift`: detener el avance de flags, comparar la revisión autoritativa y corregir antes de reanudar el rollout.
- DLQ o cola envejecida: seguir el runbook de cierre reanudable y no borrar mensajes manualmente sin evidencia.
