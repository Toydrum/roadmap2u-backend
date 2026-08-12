# Mantenimiento pendiente — 2026-08-12

## Estado

La rama local se avanzó de forma lineal hasta `origin/main` antes de preparar
este mantenimiento. Los siete documentos canónicos de `docs/codebase/` que ya
estaban publicados se conservaron.

## Bloqueador de validación local

`npm ci --ignore-scripts` se intentó en tres ejecuciones con Node 22.17.1 y npm
10.9.2 (dos estándar y una con `--no-audit`). Todas terminaron con el error
interno de npm `Exit handler never called` durante la fase `reify`; la
instalación parcial no dejó disponibles los binarios locales de
TypeScript/Vitest. Una ejecución también registró un fallo de certificado al
consultar el endpoint de auditoría de npm.

No se desactivó la validación TLS y no se ejecutaron despliegues ni comandos
contra AWS.

## Riesgo

Este commit solo añade documentación de mantenimiento, notas de onboarding y
una exclusión estrecha para un escaneo local. No modifica TypeScript,
CloudFormation, contratos, workflows ni dependencias. Aun así, la suite local
no pudo volver a ejecutarse en esta computadora.

## Bloqueador de publicación

GitHub rechazó el push directo a `main`: la rama protegida exige una pull
request y el check requerido `validate`. Los commits se publicaron en
`codex/local-analysis-maintenance-2026-08-12`; no se abrió ninguna PR.

## Próxima acción

1. Ejecutar en un checkout local (no en unidad de red) con Node 22 y npm 10.
2. Configurar correctamente la CA corporativa si el proxy TLS sigue
   interceptando `registry.npmjs.org`; no usar `strict-ssl=false`.
3. Ejecutar `npm ci --ignore-scripts`, `npm run typecheck` y `npm test`.
4. Abrir o autorizar una PR desde la rama publicada hacia `main` y confirmar
   el check `validate` antes de promover cualquier stage. No desplegar AWS como
   parte de esta comprobación.
