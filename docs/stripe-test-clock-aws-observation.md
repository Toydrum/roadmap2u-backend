# Lectura AWS del publicador de TestClock

`prepareClockAwsObserver` conecta los SDK instalados a un transporte explícito
para obtener el snapshot privado que necesitan los preparadores existentes.
No es una CLI ni descubre credenciales o secretos. El caller suministra una
copia de credenciales temporales, el ARN de identidad esperado, el User Pool,
los destinos revisados, el reloj real y una reserva por envío.

La instalación hace como máximo seis peticiones seriales: identidad STS, dos
DescribeTable, AdminGetUser, un TransactGet de ocho filas y una Query consistente
de la partición financiera con límite 100. La transición omite Query y hace
cinco. No continúa una página adicional; una respuesta incompleta no acredita
un snapshot completo. Ninguna operación de escritura está disponible.

Antes del primer envío se rechazan PROD/live, la cuenta mensual histórica,
fixtures duplicados o cruzados, tablas ajenas a las canónicas DEV/TEST, ARNs
distintos de 765932874577/us-east-1 y credenciales sin sesión o próximas a caducar.
Las respuestas deben confirmar identidad, tablas activas con claves string,
fixture Cognito deshabilitado y sub exacto. Las filas leídas conservan sus datos;
los preparadores reales siguen rechazando flags abiertos, menores, cierre,
restauración y registros financieros previos.

Cada envío se compara con la serialización real del SDK obtenida en memoria:
host, método, ruta, query, target y cuerpo exactos. El presupuesto se reserva
antes de delegar; ni un error del SDK ni un timeout permiten una segunda
delegación. Se aplica un timeout de hasta veinte segundos por petición, se
propaga aborto y el transporte se destruye una vez. El observador es de un
solo uso incluso si falla. Solo expone códigos controlados y contadores.

El resultado contiene perfil y filas privadas **solo para uso en memoria**.
No debe imprimirse o guardarse como recibo. `preview` y `counts()` permiten
reportar destinos y límites sin credenciales ni snapshots. El módulo no guarda
archivos y no lee SSM. Su validación local usa handlers en memoria, no cuentas
AWS reales.

`physicalAuthorizationChecked`, `sourceShaVerified` y `stackOwnershipVerified`
siguen false: falta el caller que compruebe la ventana humana, fuente exacta,
outputs/propiedad CloudFormation, permisos y manifiesto actuales antes de una
operación física. La identidad y tablas observadas no conceden esa autorización.
La CLI física, fixtures/relojes reales y aceptación completa DEV/TEST conservan
sus pendientes; la elección del cliente temporal no se ha inferido.

La validación local pasó 57 casos nuevos y 369 retenidos (426 en doce archivos),
más tipos. Incluye alteración de la petición SDK antes del handler, preservación
de los bloqueos de negocio reales, timeout con aborto y rechazo de un segundo
uso. Esto prueba la composición local; no acredita estado, IAM o condiciones
de DynamoDB físicos.
