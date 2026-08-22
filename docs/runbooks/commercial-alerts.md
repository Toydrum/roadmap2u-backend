# Runbook de alertas comerciales

Este runbook cubre la instalación y la prueba del canal de alertas de cada stage. La implementación local no envía correos y no completa GATE-100: un `cdk synth` crea el topic, las alarmas y una suscripción condicional desactivada por el valor vacío predeterminado, sin endpoint literal ni suscripción activa.

## Propiedad y configuración

El owner operativo mantiene un secreto de GitHub Environment llamado `ALARM_NOTIFICATION_EMAIL` en `dev`, `test` y `prod`. El workflow oficial lo valida y enmascara antes de `cdk diff` y `cdk deploy`, y lo entrega sólo como parámetro CloudFormation `AlarmNotificationEmail` con `NoEcho`; no se incorpora al contexto CDK, al template ni a `cdk.out`. Un despliegue oficial falla si falta o si su formato no es válido.

Cada stage crea:

- topic `roadmap-commercial-alerts-${stage}` con transporte TLS obligatorio;
- para cada una de las seis Lambdas, alarmas de `Errors`, `Throttles` y `Duration`; `Duration` usa `Maximum` y avisa al 80 % del timeout configurado (8 s, 8 s, 8 s, 48 s, 24 s y 12 s respectivamente);
- API 5xx; `ThrottledRequests`, `SystemErrors` y `TransactionConflict` de ambas tablas; edad de la cola de cierre; mensajes visibles en la DLQ; `ConfigurationDrift`; `CommercialConfigurationUnavailable`; y la alarma sintética;
- una sola suscripción email cuando se proporciona el secreto.

Todas las alarmas usan periodos de cinco minutos, datos faltantes como `notBreaching` y el mismo topic como acción.
`ThrottledRequests` y `SystemErrors` conservan un solo estado agregado por tabla y tipo, pero suman métricas con las dimensiones `TableName` y `Operation` para las operaciones soportadas. No uses esos dos nombres con `TableName` solamente: DynamoDB no publica esas series y la alarma permanecería sin datos. `TransactionConflict` sí usa su dimensión nativa `TableName`.
Referencia operativa: [métricas y dimensiones de DynamoDB](https://docs.aws.amazon.com/amazondynamodb/latest/developerguide/metrics-dimensions.html).

HTTP API no publica una métrica nativa separada para 429: su [inventario oficial](https://docs.aws.amazon.com/apigateway/latest/developerguide/http-api-metrics.html) incluye `4xx`, `5xx`, `Count`, latencias y datos procesados. No se inventa `Throttles`, `ThrottleCount` ni `429`, y usar `4xx` mezclaría throttling con autenticación y otros errores de cliente. Queda como gap concreto añadir un productor sanitizado de conteo 429 desde access logs antes de afirmar cobertura específica de throttling HTTP.

## Confirmación y prueba sintética

1. La persona dueña del correo acepta la invitación SNS recibida. Mientras la suscripción muestre `PendingConfirmation`, el deploy oficial se detiene.
2. El workflow verifica exactamente una suscripción email confirmada mediante `ListSubscriptionsByTopic` sobre el topic del stage.
3. Después del deploy cambia temporalmente `roadmap-commercial-${stage}-synthetic` a `ALARM`, verifica el estado con `DescribeAlarms`, deja una ventana para la notificación y la devuelve a `OK`.
4. El owner confirma fuera de banda la recepción del correo y guarda sólo evidencia sanitizada. La ejecución local y el cambio de estado por sí solos no completan GATE-100.

El workflow y sus roles IAM no reciben `sns:Publish` ni `cloudwatch:PutMetricData`: el rol OIDC sólo puede listar las suscripciones del topic exacto y describir/cambiar el estado de la alarma sintética exacta. La policy de recurso del topic sí permite `sns:Publish` exclusivamente al principal `cloudwatch.amazonaws.com`, condicionado a la cuenta y al prefijo de alarmas del mismo stage; sin esa concesión CloudWatch no podría entregar alertas.

## Métricas EMF

`emitCommercialMetric` acepta únicamente métricas comerciales y stages allowlisted y no recibe request IDs, usuarios, correos, cuerpos ni códigos. El `CommercialConfigBroker` emite `CommercialConfigurationUnavailable` ante una respuesta 503.

`ConfigurationDrift` queda disponible para los lectores runtime de flags. Cuando esos adaptadores se creen, deben inyectar `emitCommercialMetric(metric, stage)` en `CommercialFlagsResolver`; hasta entonces la ruta está documentada y probada, pero no se debe afirmar que existe un lector productivo conectado.

## Respuesta

- Lambda/API/Dynamo/SQS: revisar el recurso y el request ID en logs estructurados, sin copiar PII al incidente.
- `CommercialConfigurationUnavailable`: mantener issuance, redemption y payments apagados; lectura y operaciones seguras siguen la matriz fail-closed.
- `ConfigurationDrift`: detener el avance de flags, comparar la revisión autoritativa y corregir antes de reanudar el rollout.
- DLQ o cola envejecida: seguir el runbook de cierre reanudable y no borrar mensajes manualmente sin evidencia.
