# Privacidad: adultos y adolescentes privados

Preparado el 7/10/2026. Código y pruebas locales; lectura inicial de metadatos AWS realizada, sin instalación, reconciliación, ensayo de atención o activación PROD. Familias y pagos conservan sus ventanas independientes. Autorización de privacidad no es autoridad familiar ni comercial.

## Atención y verificación

Responsable: Héctor Coronado. Contacto: overseer@roadmap2u.com. Domicilio confirmado: Camelias 8, colonia Tlacoquemecatl del Valle, alcaldía Benito Juárez, C.P. 03200, Ciudad de México, México.

El 7/10/2026 Héctor Coronado decidió continuar sin revisión externa de abogado y aprobó el alta por declaración autenticada. Antes de activar, el responsable aprueba una vez los textos exactos y el procedimiento de atención/escalación. La app no recibe identificaciones. Email, username, JWT y casilla no acreditan documentos de patria potestad o tutela. Disputas y trámites de derechos comprueban identidad, autoridad y alcance adecuados al caso.

El alta rutinaria nueva no pasa por este procedimiento manual: el usuario aprobó `account_attestation`. La API comprueba correo confirmado, sesión reciente, admisión adulta y Premium; registra nombre/calidad declarados y decisiones. Esto identifica una cuenta, no verifica documentos de parentesco o tutela. El adolescente confirma correo, acepta su explicación y elige nube separadamente. No hay lectura del bosque para el adulto. La comprobación individual siguiente corresponde a disputas y derechos.

1. Registrar referencia opaca, fecha de recepción, petición, destinatario y vía de respuesta. No poner notas, salud, documentos o credenciales en CLI, auditoría, tickets públicos o Git.
2. Verificar identidad, representación, destinatario exacto y edad 12–17 por el canal aprobado. La app conserva fecha de mayoría. Registrar decisión y revisión en expediente privado.
3. Verificar ambiente, cuenta AWS `765932874577`, operador y estado canónico. Preparar acción exacta, revisión y caso. Obtener autorización DEP-012 para esa ventana externa.
4. Aplicar únicamente esa acción, releer resultado y comunicarlo por vía verificada. Un conflicto exige lectura actual antes de otro plan. Una solicitud aceptada no prueba supresión física.
5. Distinguir logout, desconexión, revocación, cancelación remota y cierre total. Derechos no requieren Premium ni respaldo obligatorio. El representante no tiene lectura/exportación diaria; el acceso representado se resuelve por soporte con comprobación individual de autoridad, sin crear supervisión.

### Nube vinculada al Premium del representante

Decisión del usuario del 7/10/2026: la nube adolescente depende del Premium vigente de la cuenta responsable autorizada. Se deriva de las fuentes actuales y no escribe concesiones ni ACCESS por esta vinculación. Cada escritura del adolescente condiciona ACCESS y las fuentes de pago del adulto junto con ambas decisiones de privacidad. Conserva límites Free y no concede Premium, acceso al bosque, familia o funciones sociales. Revocación, vencimiento, cierre del adulto o mayoría detienen nube; exportación y cancelación propias siguen disponibles. DEV/TEST deben probar pérdida y recuperación de Premium sin renovar automáticamente consentimientos retirados.

## Operador preparado

`bootstrap/privacy-operator.template.json` es independiente y **no está instalado**. Rol `roadmap2u-<stage>-privacy-operator`, path `/roadmap2u/<stage>/operators/`, principal humano exacto, MFA de origen hasta ocho horas y sesión de rol de una hora. Instalación requiere ventana propia. CLI rechaza otra cuenta/rol. No concede Scan, DeleteItem, Cognito, flags, Premium, REC ni PassRole. GetItem principal lleva proyección de metadatos; una denegación IAM no autoriza fallback a contenido completo. IAM limita recursos y atributos; el dominio fija identidad, destinatario, revisión y caso. El operador atiende casos y derechos; el alta rutinaria usa declaración autenticada.

Desde backend, el preview **offline**, sin cargar credenciales ni consultar AWS:

```powershell
node node_modules/tsx/dist/cli.mjs scripts/privacy-operator.ts --stage dev --plan <archivo.json>
```

Devuelve hash y `applied:false`. La escritura exige `--apply --confirm-stage dev --confirm-hash <hash-del-preview> --profile <perfil-del-rol-exacto>` y autorización concreta previa. No ejecutarla como prueba local.

### Verificación de invitación manual anterior

Las nuevas invitaciones nacen autorizadas por declaración autenticada, sin caso documental ni operador ficticios. Las invitaciones manuales anteriores `pending_verification` conservan su estado y solo se verifican si existe comprobación real. Vigencia de siete días, vinculadas al username y fecha de mayoría exactos. Ejemplo **sintético** del mecanismo anterior que debe sustituirse y revisarse:

```json
{"action":"verify_representation","command":{"invitationId":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","guardianId":"synthetic-parent-id","recipientUsername":"synthetic_teen","majorityAt":"2029-10-07","expectedRevision":1,"commandId":"verified-case-command-1","caseId":"verified-case-1"}}
```

Verificar cambia a `authorized`; aún no crea cuenta privada, nube, hogar ni Premium. Adolescente acepta autenticado con username exacto, términos y explicación. Perfil técnico inicial `adult` no acredita admisión. Se rechazan cuentas declaradas adultas y relaciones familiares/sociales existentes. La aceptación atómica fija menor privado, social apagado y evidencia independiente.

Retirar por representante detiene nuevas operaciones, conserva cuenta/bosque y no reactiva después la elección retirada por el adolescente. Cada reautorización exige revisión/texto actuales; adolescente vuelve a decidir nube. Exportación/cancelación propias siguen disponibles sin Premium. A los 18 (fecha civil México), worker termina autoridad parental/nube, conserva datos y privacidad social. Aceptación adulta/nube propias son nuevas decisiones. Disputa o sustitución se escalan; no editar edad ni inventar consentimiento. No existe sustitución automatizada en este MVP.

### Cierre completo por solicitud verificada

```json
{"action":"request_private_closure","command":{"userId":"synthetic-teen-id","username":"synthetic_teen","guardianId":"synthetic-parent-id","invitationId":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","expectedRevision":3,"commandId":"closure-command-1","caseId":"verified-closure-case-1"}}
```

Mismo preview/hash. Exige perfil privado menor aún vigente, invitación aceptada con autorización canónica y revisión canónica. Admite alta `account_attestation` o verificación real anterior; ninguna sustituye la comprobación de autoridad y alcance del **nuevo caso de cierre** por soporte. La declaración del alta no es un caso documental ficticio. Nube retirada no impide derechos. No pide Premium o descarga. Registra `closing` y outbox durable; no elimina directamente. Reconciliador/worker siguen fases, obligaciones y exclusión independiente antes de purgar. Para afirmar conclusión comprobar `completed`, partición vacía, exclusión final e invitación revocada; conservar cuentas ajenas. Eliminación irreversible concreta requiere autorización expresa para la ventana.

### Bloqueo por obligación

`action:"hold"` con `command.action:"set"|"release"`, sujeto exacto, `caseId`, `commandId` y `expectedRevision` de `RESTORE#<id>/STATE` (0 ausente). Alta además: `scope` forest/account/consent/audit/commercial, fundamento concreto `legalBasis`, `expiresAt`, `reviewAt` (milisegundos UTC, revisión no posterior al vencimiento). Sin documentos/datos íntimos en el fundamento. Alta exige cuenta activa; liberar puede continuar tras cierre físico. Bloqueo comercial no conserva todo el bosque. Evidencia necesaria se archiva con atributos y vencimiento explícitos. Worker comprueba obligación antes de purga ordinaria; TTL eventual no la sustituye.

Un bloqueo de alcance `consent` conserva en `CONSENT_ARCHIVE#<id>` la evidencia mínima de autorización `guardianAuthorization`, tanto `account_attestation` como la verificación manual anterior. Su vencimiento corresponde al caso, aunque supere la ventana de exclusión de restauración. No incluye notas, árboles ni contenido del bosque. El cierre físico elimina el ledger vigente y revoca/acorta la invitación; por eso estos registros no sustituyen el archivo del consentimiento bajo obligación documentada.

## Inventario y reconciliación preparados

La lectura inicial de metadatos del 7/10/2026 observó backend `5a4bb3b` en DEV/TEST/PROD, frontend `cef5964` en DEV/TEST y `42a5dd7` en PROD; modos/recursos nuevos aún no instalados, familias/pagos cerrados y PITR PROD de 35 días. Los conteos aproximados de la tabla no prueban reconciliación. La reconciliación siguiente aún no se ejecutó; continuar con la ventana concreta autorizada:

1. Fijar SHA frontend/backend y hash contractual. Leer flags, versiones, cifrado/PITR/TTL, permisos y alarmas reales; síntesis local no acredita configuración efectiva.
2. Paginar perfiles/decisiones con claves permitidas. Comparar `PRIVACY#ADULT` con registro independiente **vigente** `PRIVACY_STATE#<id>/STATE`: revisión, hash y campos mínimos. Diferencia bloquea; no sobreescribir el registro vigente con datos restaurados.
3. Inventariar cierres, purga/mayoría, invitaciones, obligaciones y exclusiones; reconciliar conteos/referencias. Privados deben carecer de hogares, cobertura y vínculos antiguos. Auditoría histórica queda `review_required`; no clasificarla automáticamente como ordinaria o comercial.
4. Preparar aparte cualquier backfill aditivo, condiciones, inventario antes/después, presupuesto y recuperación. No convertir adultos existentes a adolescentes ni reactivar decisiones. Migración legacy necesita su ventana específica.
5. Ensayar DEV/TEST sintético: representante falso, otro destinatario, caducidad, CAS, retirada durante sync, relación antigua, renovación, mayoría, Free/exportación y cancelación física. Ensayar atención manual/entrega verificada además de smoke técnico.

## Recuperación

Restaurar PITR aislado y conservar tabla de privacidad vigente. Reaplicar exclusiones `RESTORE#` y retiradas antes de abrir contenido. Cierre pendiente sin TTL; exclusión final mínima 36 días para PITR propuesto hasta 35. Epochs anteriores a cancelación se excluyen; datos nuevos necesitan autorización/revisión posterior. Otra copia más larga exige horizonte mínimo justificado y ensayo. Restaurar ambos registros antiguos juntos no es reconciliación.

Antes de abrir: comprobar particiones vacías, epochs excluidos, ledger coherente, nube detenida y privados sin acceso social. Guardar recibo saneado. Gate PROD exige textos ES/EN exactos revisados, fecha efectiva, proveedor real, canal seguro, ensayos, flags y SHA; los campos actuales siguen pendientes.
