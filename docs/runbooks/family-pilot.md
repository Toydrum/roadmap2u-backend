# Piloto familiar por invitación

## Estado y límites

Este procedimiento prepara DEV y TEST. La activación familiar en PROD requiere la aprobación del aviso de privacidad y términos ES/EN, identidad, domicilio y contactos del responsable, y la aprobación de los procedimientos de soporte y privacidad. Hasta entonces, `familyCreationEnabled`, `minorLinkingEnabled` y `minorSocialEnabled` permanecen apagados en PROD. `checkoutEnabled`, `subscriptionChangesEnabled` y `premiumPaymentsEnabled` permanecen apagados en todos los ambientes del piloto.

Una cuenta adulta puede registrarse sin invitación. Solo una concesión `sponsored_pilot` del operador habilita el hogar familiar. La app no tiene una ruta para concederla. La concesión cubre hasta dos menores y una persona responsable adicional, no tiene vencimiento automático y no crea una suscripción ni una fecha de pago. La revocación termina las capacidades nuevas y conserva cuentas, bosques y vínculos de cuidado.

## Preparación de cada ambiente

1. Registrar los SHA exactos de backend y frontend, el hash contractual y el resultado verde de ambos CI. El SHA de contrato del frontend debe existir en GitHub antes del CI del backend.
2. Revisar el diff CDK y las policies del broker, el reconciliador de mayoría y el rol MFA `roadmap2u-<stage>-family-pilot-operator`. Actualizar `Roadmap-CiBootstrap` antes de la carga. Conservar el diff y comprobar que no reemplaza tablas, User Pool ni recursos de datos existentes.
3. Desplegar primero el backend del SHA aprobado con los tres flags familiares apagados. Confirmar el marcador y manifiesto de release, rutas sin token 401, Checkout y cambios de suscripción desactivados.
4. Con el rol MFA `roadmap2u-<stage>-commercial-migration`, ejecutar el inventario de hogares y edades. Los comandos hacen lecturas proyectadas y no escriben sin `--apply`:

   ```powershell
   npm run commercial:family-model -- --operation inventory --stage <stage> --account 765932874577 --profile <profile>
   npm run commercial:family-majority -- --operation inventory --stage <stage> --account 765932874577 --profile <profile>
   ```

5. Revisar conteos, anomalías y `manifestHash`/`planHash`. La migración familiar es aditiva. No inventar fechas de mayoría: cada menor sin declaración válida queda en el inventario y necesita resolución antes de participar en el piloto. No aplicar con deriva de índice o vínculos ambiguos.
6. Ensayar la recuperación en DEV: guardar una copia segura del manifiesto y checkpoint fuera de Git, interrumpir una ejecución de prueba después de un lote, reanudar con el mismo checkpoint y verificar que las filas ya escritas no se duplican. Registrar el conteo antes/después y una reconciliación sin diferencias. Repetir la comprobación de recuperación en TEST antes de activar flags.
7. Para una migración aprobada, volver a ejecutar el dry run y aplicar solo con el hash que corresponda al estado actual. El CLI vuelve a leer el inventario antes de escribir y exige stage y cuenta exactos:

   ```powershell
   npm run commercial:family-model -- --operation backfill --stage <stage> --account 765932874577 --profile <profile>
   npm run commercial:family-model -- --operation backfill --stage <stage> --account 765932874577 --profile <profile> --apply --confirm-stage <stage> --confirm-account 765932874577 --confirm-hash <manifestHash> --checkpoint-file <ruta-privada-checkpoint> --manifest-file <ruta-privada-manifest>
   npm run commercial:family-model -- --operation reconcile --stage <stage> --account 765932874577 --profile <profile>
   npm run commercial:family-majority -- --operation backfill --stage <stage> --account 765932874577 --profile <profile>
   npm run commercial:family-majority -- --operation backfill --stage <stage> --account 765932874577 --profile <profile> --apply --confirm-stage <stage> --confirm-account 765932874577 --confirm-hash <planHash>
   npm run commercial:family-majority -- --operation reconcile --stage <stage> --account 765932874577 --profile <profile>
   ```

   Conservar los manifiestos sanitizados y los conteos, no datos de menores. El rol de migración debe corresponder al stage; no usar credenciales de administrador para eludirlo.

## Concesión y revocación

Con el rol MFA `roadmap2u-<stage>-family-pilot-operator`, obtener la identidad adulta exacta, el hogar cuyo responsable principal coincide y las revisiones actuales. Cada comando necesita UUID v4, motivo interno y revisión esperada. Ejecutar primero el dry run y copiar su hash; añadir `--apply --confirm-stage <stage> --confirm-hash <hash>` únicamente tras revisar la identidad y el hogar.

```powershell
npm run commercial:family-pilot -- grant --stage <stage> --url <function-url-del-stage> --profile <profile> --adult-id <sub-adulto> --household-id <id-hogar> --expected-household-revision <n> --expected-entitlement-revision <n> --command-id <uuid-v4> --reason 'cohorte-invitada-01'
```

Para revocar, usar `revoke` con nuevas revisiones y un UUID nuevo. El broker exige rol y cuenta exactos, verifica perfiles, asientos y revisiones dentro de una transacción, y escribe auditoría. Un conflicto requiere inventario nuevo antes de decidir otro comando; reutilizar el mismo UUID solo para consultar el resultado idempotente del mismo intento. Confirmar que la cuenta no invitada recibe `PAYMENT_REQUIRED` o `CAPABILITY_REQUIRED` en creación/vinculación.

## Activación gradual y prueba autenticada

En DEV y después TEST, habilitar por separado `familyCreationEnabled`, `minorLinkingEnabled` y `minorSocialEnabled` con `commercial:set`, cada cambio con revisión CAS, dry run y hash. Mantener Checkout y cambios de suscripción en `false`. Antes del siguiente flag, usar dos hogares piloto y comprobar con sesiones reales:

- dos menores y rechazo del tercer asiento; responsable adicional limitado a los menores elegidos;
- código de vinculación de un menor existente, aprobación del responsable actual y aceptación del nuevo hogar;
- propuesta de transferencia que deja al responsable actual vigente hasta aceptación expresa;
- amistad infantil que permanece pendiente hasta las acciones de ambos menores y ambos responsables; rechazo y revocación sin activar amistad;
- revocación piloto que bloquea capacidades nuevas y preserva cuentas, bosques y supervisión;
- transición al cumplir 18 años: fin de supervisión y cobertura piloto del adulto emergente, conservación de cuenta y datos, y conservación de Premium solo si tiene fuente propia;
- cuenta adulta sin concesión que no puede activar familia; API sin autenticación que responde 401.

Registrar por ambiente el SHA backend, SHA frontend, revisiones de flags, hashes de migración, IDs sanitizados de comandos, resultados de pruebas y rollback elegido. Publicar frontend solo después de que el backend compatible, migración, reconciliación y smoke hayan pasado. Promover los mismos SHA por DEV → TEST → PROD usando los workflows y marcadores; no reconstruir desde otro commit.

## Detener o recuperar

Si falla un smoke, apagar primero el flag de la capacidad afectada mediante su broker y revisión actual. No borrar cuentas ni vínculos como rollback de una concesión. Para un fallo de migración, detener escrituras, conservar checkpoint y eventos de DynamoDB, reconciliar el inventario, corregir la causa y reanudar solo con un hash vigente. Para un fallo de deploy, usar el workflow de rollback del mismo stage y sus marcadores; nunca reintentar ciegamente una operación AWS fallida.

PROD permanece sin activación familiar hasta que estén aprobados los borradores legales y el [procedimiento de soporte y privacidad](family-support-privacy.md), completos con identidad, domicilio, contactos, plazos y responsables reales.
