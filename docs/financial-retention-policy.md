# RoadMap2U: conservación financiera

Versión: mx-financial-2026-10-22-v1. Alcance: registros comerciales de suscripciones individuales; el titular aprobó su diseño e implementación el22/10/2026. La vinculación técnica no certifica emisión fiscal, clasificación individual, un plazo ya vencido o acceso autorizado a información ajena.

## Finalidad y custodios

El contador custodia únicamente la documentación necesaria para el proceso externo de facturación, entrega y corrección de CFDI. El titular mantiene el control y la responsabilidad sobre las obligaciones del negocio. No se concede al contador acceso administrativo a AWS/Stripe ni acceso a perfiles, bosque, notas, credenciales, consentimientos o datos de otros usuarios. No se crea un almacén fiscal dentro de la aplicación.

La solicitud usa el canal fiscal ya elegido. Sólo comunica los datos del receptor necesarios y una referencia propia al pago/renovación confirmados; no entrega el historial completo del usuario. Formalizar finalidad, confidencialidad y tratamiento de copias en el encargo al contador. El canal debe comprobar recepción y entrega XML/PDF; el recibo Stripe no sustituye el CFDI. No se exige una CSF completa como condición nueva.

## Reglas de conservación

- Documentación fiscal: identificar la obligación y declaración relacionadas. La regla general del [CFF, artículo30](https://www.diputados.gob.mx/LeyesBiblio/pdf/CFF.pdf#page=61), es de cinco años con inicio ligado a las declaraciones; sus excepciones pueden cambiar el cómputo. No iniciar el plazo por la baja de la cuenta.
- Comprobantes y documentos mercantiles comprendidos en los supuestos legales: contemplar el mínimo de diez años del [Código de Comercio, artículos38,46 y49](https://www.diputados.gob.mx/LeyesBiblio/pdf/CCom.pdf#page=14). Registrar su aplicabilidad y el inicio acreditado.
- Cumplir las obligaciones concurrentes y las excepciones documentadas. La revisión no trata todos los logs como expediente fiscal ni aplica un plazo universal a todos los datos.
- Separar el contenido de la aplicación del expediente exigible. Finalidad, minimización, seguridad, confidencialidad y bloqueo/supresión se rigen por los [artículos10–12,18,20,24–25 de la LFPDPPP](https://www.diputados.gob.mx/LeyesBiblio/pdf/LFPDPPP.pdf#page=5). Una conservación legal no habilita usos secundarios.

Fuentes oficiales consultadas el22/10/2026: CFF con reforma09/04/2026; Código de Comercio con reforma14/11/2025 y cantidades actualizadas18/02/2026; LFPDPPP con reforma14/11/2025. Revisar cambios normativos antes de actualizar esta política o ejecutar una disposición final.

## Expediente y revisión operativa

El responsable registra por expediente: categoría, fundamento aplicable, referencia propia al pago/factura, custodio, declaración/evento de inicio con evidencia, vencimientos concurrentes, excepciones/bloqueos y próxima revisión. Si falta clasificación o inicio, registrar el pendiente y revisarlo al cierre del periodo contable; no inventar una fecha ni mantener el pendiente sin revisión.

Las copias auxiliares y datos voluntarios se limitan a lo necesario. El plazo legal del expediente no extiende automáticamente la vida de toda copia, correo, CSF, perfil o contenido personal. El cierre de usuario conserva únicamente los registros financieros exigibles, separados de USER y de sus plazos de privacidad.

## Bloqueos, vencimiento y restauración

Antes de disponer de un expediente, comprobar los vencimientos aplicables y ausencia de bloqueo legal/contractual. Un bloqueo registra autoridad/motivo, alcance, evidencia, responsable y revisión; su levantamiento también queda documentado. Los recursos, juicios y efectos fiscales prolongados necesitan su cómputo propio.

La eliminación/disociación se prepara como propuesta con alcance exacto, copias y respaldos; requiere autorización específica del titular antes de ejecutar una acción irreversible. Registrar el resultado y el tratamiento de copias externas con el custodio. Ningún TTL ni borrado automático se deriva sólo de la fecha de cobro o baja.

Al restaurar, reaplicar exclusiones de cuentas eliminadas y no revivir periodos devueltos/invalidados. La conservación de documentos no reactiva suscripciones, accesos o consentimientos.

## Enlace al software

El binding contiene versión, SHA256 de este documento y referencia de aprobación vigente. PROD requiere el binding exacto además de términos/aprobaciones comerciales, flags y admisión. Ausencia, retirada o divergencia cierra compras, manteniendo cancelación, webhook y recuperación disponibles.

Los productores financieros registran la política vinculada y el estado de clasificación individual pendiente; no afirman que ya exista fecha de eliminación. Los datos históricos DEV/TEST no se reclasifican por esta publicación. PAN, CVC, secretos y payloads completos no pertenecen al expediente. La aprobación de esta política no autoriza enviar correos, compartir archivos, crear permisos, borrar información ni ejecutar pagos.
