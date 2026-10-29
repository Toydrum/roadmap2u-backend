/** Immutable evidence payloads. Never derive these accepted documents from current UI copy. */
export const HISTORICAL_PRIVACY_DOCUMENTS = {
  "es": {
    "versions": {
      "noticeVersion": "privacy-2026-10-07-v2",
      "termsVersion": "terms-2026-10-07-v2",
      "cloudConsentVersion": "cloud-consent-2026-10-07-v2"
    },
    "language": "es",
    "notice": {
      "title": "Aviso de privacidad",
      "intro": "RoadMap2U funciona primero en tu dispositivo. Este aviso explica el tratamiento de datos de cuentas adultas y de cuentas adolescentes privadas de 12 a 17 años.",
      "sections": [
        {
          "title": "Responsable y contacto",
          "paragraphs": [
            "Héctor Coronado, persona física, es responsable de RoadMap2U. Domicilio para notificaciones: Camelias 8, colonia Tlacoquemecatl del Valle, alcaldía Benito Juárez, C.P. 03200, Ciudad de México, México. Privacidad y soporte: overseer@roadmap2u.com."
          ]
        },
        {
          "title": "Datos y finalidades",
          "paragraphs": [
            "La cuenta utiliza correo, identificador, username, nombre mostrado y atributos de acceso para registro, autenticación, recuperación, seguridad y atención de solicitudes. Iniciar o cerrar sesión no borra tu bosque del dispositivo.",
            "Al autorizar la nube se almacenan los árboles, ramas, notas, check-ins, sesiones, cosechas y conservas que sincronices para guardar y recuperar tu propio bosque entre dispositivos. Las notas y check-ins pueden revelar datos sensibles, como salud o creencias. Su almacenamiento y sincronización requieren tu autorización expresa, separada de los términos de cuenta. Puedes usar el bosque local sin autorizar esa sincronización.",
            "Conservamos evidencia de decisiones de privacidad —sujeto, texto, idioma, versión, fecha y revisión— para aplicar y acreditar tus elecciones. RoadMap2U no incorpora anuncios, analítica ni rastreadores, y no vende el contenido de tu bosque."
          ]
        },
        {
          "title": "Adolescentes con cuenta privada",
          "paragraphs": [
            "La modalidad de 12 a 17 años utiliza una declaración autenticada de padre, madre o tutor: correo confirmado, inicio de sesión reciente, cuenta adulta admitida y Premium vigente. Guardamos nombre completo y calidad declarados, identificadores del responsable y destinatario exacto, fecha de mayoría, texto, idioma, versiones y evidencia de las decisiones. Este alta no verifica documentos de identidad, parentesco o tutela. No envíes identificaciones en tus notas ni en el formulario de la app.",
            "El adolescente recibe su propia explicación y decide por separado si usa la nube. Su bosque no permite amistades, visitas, búsqueda de usuarios ni conexiones con bosques ajenos. La autorización del representante no le concede lectura cotidiana ni exportación del bosque, cobertura familiar o Premium.",
            "La capacidad de nube del adolescente depende del Premium vigente de ese representante; el bosque conserva los límites Free. Si termina esa capacidad, se detiene la nube sin borrar la cuenta o el bosque. Descargar datos y ejercer derechos de privacidad no requiere Premium.",
            "Al cumplir 18 años conserva cuenta y datos; termina la autorización parental y se requiere su propia aceptación adulta y autorización de nube, junto con una capacidad propia cuando corresponda. La restricción social permanece. Una disputa o cambio de representante se atiende por soporte con verificación; no existe transferencia automática."
          ]
        },
        {
          "title": "Dispositivo, nube y proveedores",
          "paragraphs": [
            "El bosque funciona localmente. Autenticación y gestión de cuenta sí utilizan servicios remotos; rechazar sincronización no convierte la cuenta en anónima. La nube utiliza Amazon Web Services (AWS): Cognito, API Gateway, Lambda y DynamoDB, con servicios regionales en Estados Unidos. La aplicación web se distribuye mediante CloudFront. Estos proveedores intervienen en la prestación y protección del servicio, por lo que existe tratamiento fuera de México.",
            "Las funciones sociales adultas solo operan cuando estén habilitadas y autorizadas. Las visitas tienen una vista limitada y no incluyen check-ins ni sesiones. La modalidad adolescente privada bloquea todos esos accesos, incluso para un representante con vínculos anteriores. Los archivos que descargues quedan bajo tu control.",
            "No se comparte el contenido del bosque para publicidad o finalidades ajenas al servicio. Una comunicación exigida por una obligación legal o autoridad competente se limita a los datos y alcance que correspondan."
          ]
        },
        {
          "title": "Tus decisiones y derechos",
          "paragraphs": [
            "Puedes seguir en el dispositivo, autorizar la nube o retirar después tu autorización desde Mi privacidad. Desconectar un dispositivo solo detiene su sincronización. Revocar detiene nuevas operaciones de nube y conserva las copias existentes hasta su cancelación correspondiente.",
            "Puedes descargar tus datos remotos y solicitar cancelación del bosque remoto sin Premium ni descarga obligatoria. La cuenta y el bosque del dispositivo se conservan. Cierre de cuenta, copias locales y archivos descargados tienen alcances distintos.",
            "Las solicitudes de acceso, rectificación, cancelación, oposición, revocación o limitación se reciben en overseer@roadmap2u.com. Indica tu nombre, medio de respuesta, la cuenta y lo que solicitas; para rectificación, el cambio que buscas. Se comprobará tu identidad y, cuando corresponda, representación mediante un canal privado acordado para el caso. No envíes contraseñas, MFA ni tokens.",
            "En solicitudes sobre adolescentes no se presume autoridad por conocer su username o recibir un email. La determinación se comunica en un plazo máximo de 20 días hábiles desde la recepción de la solicitud y, si procede, se hace efectiva dentro de los 15 días hábiles siguientes. Las ampliaciones justificadas se comunican conforme a las reglas aplicables. La entrega electrónica disponible es gratuita."
          ]
        },
        {
          "title": "Conservación, supresión y seguridad",
          "paragraphs": [
            "Cuenta y bosque se conservan mientras continúe su finalidad y, para la nube, la autorización correspondiente. La cancelación se procesa por lotes y se verifica. Si una obligación concreta exige bloqueo, se registra motivo, categoría, alcance, revisión y vencimiento; no se conserva todo indefinidamente.",
            "El calendario operativo distingue registros ordinarios y logs de hasta 30 días, puntos de recuperación de hasta 35 días y exclusiones mínimas de restauración durante 36 días tras la supresión. Son decisiones técnicas, no plazos universales impuestos por la ley. La evidencia de consentimiento y verificaciones se conserva según su finalidad; cualquier obligación fiscal o comercial tiene su alcance y regla propios.",
            "La infraestructura utiliza HTTPS, cifrado de DynamoDB en reposo, autorización por cuenta y permisos administrativos limitados. Una restauración del bosque no puede restablecer autorizaciones retiradas ni datos excluidos: se contrasta con el registro de privacidad independiente. El cifrado de AWS no protege por sí solo los archivos que descargas ni sustituye la seguridad de tu dispositivo."
          ]
        },
        {
          "title": "Cambios del aviso",
          "paragraphs": [
            "El aviso vigente se publica en /privacy y los términos en /terms. Sus versiones se identifican en la evidencia de tu decisión. Los cambios de finalidad o consentimiento requieren información y una nueva decisión cuando corresponda. Conservamos el texto, idioma, versión y fecha que realmente aceptaste."
          ]
        }
      ]
    },
    "terms": {
      "title": "Términos de uso",
      "intro": "RoadMap2U es una herramienta de organización personal: tus metas crecen como árboles, ramas y siguientes pasos. No ofrece diagnóstico ni tratamiento médico ni sustituye atención profesional.",
      "sections": [
        {
          "title": "Cuenta y modalidad de uso",
          "paragraphs": [
            "Adultos eligen su modalidad y aceptan estos términos. Adolescentes de 12 a 17 años usan cuenta privada tras declaración autenticada de padre, madre o tutor, además de su propia aceptación y correo confirmado. Quien autoriza declara verazmente su nombre, relación y facultad de representación; la app comprueba su cuenta, no sus documentos civiles. No se ofrece alta de menores de 12 en esta modalidad.",
            "Cada persona protege sus credenciales y proporciona datos de cuenta veraces. La cuenta privada adolescente no permite visitas ni amistades, y la autorización del representante no abre sus notas. El bosque local se conserva al entrar, salir o rechazar la nube."
          ]
        },
        {
          "title": "Nube y capacidades",
          "paragraphs": [
            "La sincronización necesita autorización de privacidad vigente y la capacidad comercial correspondiente. Tener Premium no sustituye el consentimiento. Autorizar privacidad no concede Premium ni familia.",
            "La nube adolescente se vincula al Premium vigente de la cuenta responsable que registró la autorización y conserva los límites Free: dos árboles activos y diez ramas visibles por árbol. Terminar el Premium o retirar una autorización detiene nuevas operaciones de nube y conserva los datos. El adolescente no recibe Premium propio, funciones sociales ni acceso familiar por este vínculo.",
            "Las funciones familiares permanecen desactivadas en este lanzamiento. Las concesiones patrocinadas son gratuitas y no se venden. Las condiciones de pagos, renovaciones, cancelaciones y devoluciones se describirán antes de habilitar compras; esta modalidad no ofrece compra ni activa Stripe."
          ]
        },
        {
          "title": "Privacidad, cierre y soporte",
          "paragraphs": [
            "Archivar un elemento, cancelar el bosque remoto y cerrar la cuenta son operaciones distintas. El aviso de privacidad explica copias, conservación, derechos y excepciones. La cancelación no exige comprar Premium ni descargar un archivo.",
            "Al cumplir 18, la cuenta privada y sus datos se conservan; termina la autorización parental y se solicita aceptación propia adulta antes de continuar nube. No se abren funciones sociales automáticamente.",
            "Ayuda y reclamaciones: overseer@roadmap2u.com. Las solicitudes sobre adolescentes se tramitan con verificación de identidad y representación adecuada al caso. Nunca compartas contraseña, MFA ni tokens."
          ]
        },
        {
          "title": "Disponibilidad y reglas aplicables",
          "paragraphs": [
            "Pueden existir interrupciones por mantenimiento, conectividad o incidentes. El bosque local y las copias que decidas descargar ayudan a conservar tu trabajo; la nube no garantiza disponibilidad continua. El acceso remoto puede limitarse por seguridad, cierre solicitado o incumplimiento de estas condiciones, conservando los derechos de privacidad que correspondan.",
            "Usa la aplicación para contenido propio o que tengas derecho a utilizar, sin vulnerar derechos de terceros ni intentar acceder a cuentas ajenas. Estos términos se interpretan conforme a la legislación mexicana y no limitan derechos irrenunciables de privacidad o de las personas consumidoras. Las reclamaciones pueden presentarse ante la autoridad competente."
          ]
        }
      ]
    },
    "declaration": {
      "adult": "Ya cumplí 18 años.",
      "terms": "He leído y acepto los términos de uso de RoadMap2U."
    },
    "cloud": {
      "title": "Tu bosque, tu decisión sobre la nube",
      "body": "Tu bosque sigue aquí, en este dispositivo. Si lo conectas, RoadMap2U guardará en AWS, con servicios regionales en Estados Unidos, los árboles, ramas, notas, check-ins, sesiones, cosechas y conservas que sincronices para recuperarlos en tus dispositivos.",
      "sensitive": "Las notas y check-ins pueden incluir información íntima, como salud o creencias. Se usarán para las funciones de tu bosque. Puedes continuar en este dispositivo o retirar después tu autorización desde Privacidad.",
      "authorization": "Autorizo expresamente a Héctor Coronado, responsable de RoadMap2U, a almacenar y sincronizar el contenido de mi bosque, incluidas mis notas y check-ins y los datos sensibles que voluntariamente contengan, para las funciones descritas en el aviso de privacidad."
    },
    "adolescent": {
      "version": "private-adolescent-2026-10-07-v2",
      "explanation": "Mi bosque es privado. No tiene amistades, visitas ni conexiones con otros bosques. Mi padre, madre o tutor autoriza el uso de cuenta y nube; esa autorización no abre mis notas a esa persona. La nube necesita su Premium vigente y mi propia autorización; mi bosque conserva los límites Free. Si termina esa capacidad, mis datos no se borran. Puedo seguir en este dispositivo, descargar mis datos o retirar mi decisión de nube. Si mis notas cuentan algo íntimo, como salud o creencias, también quedaría guardado al sincronizar.",
      "authorizationModel": "Mi correo confirmado, un inicio de sesión reciente y Premium vigente permiten registrar esta declaración. RoadMap2U no verifica documentos de identidad, parentesco o tutela en este alta. El adolescente decide después si acepta su cuenta y la nube.",
      "declaredName": "Mi nombre completo declarado",
      "declaredRelationship": "Mi relación con el adolescente",
      "parentRelationship": "Soy su padre o madre",
      "legalGuardianRelationship": "Soy su tutor legal",
      "understanding": "Entiendo cómo funciona mi bosque privado y acepto usar mi cuenta con esta explicación.",
      "representation": "Declaro que ejerzo la patria potestad o tutela del adolescente indicado y que tengo facultad para representarlo en esta autorización.",
      "authorization": "Autorizo expresamente a Héctor Coronado a tratar los datos de cuenta y sincronizar el bosque del adolescente indicado, incluidos los datos sensibles que voluntariamente contengan sus notas y check-ins, para las funciones descritas en el aviso. Esta autorización no me da acceso cotidiano a su bosque."
    }
  },
  "en": {
    "versions": {
      "noticeVersion": "privacy-2026-10-07-v2",
      "termsVersion": "terms-2026-10-07-v2",
      "cloudConsentVersion": "cloud-consent-2026-10-07-v2"
    },
    "language": "en",
    "notice": {
      "title": "Privacy notice",
      "intro": "RoadMap2U works on your device first. This notice explains data processing for adult accounts and private adolescent accounts for ages 12 to 17.",
      "sections": [
        {
          "title": "Controller and contact",
          "paragraphs": [
            "Héctor Coronado, an individual, is the controller of RoadMap2U. Notice address: Camelias 8, colonia Tlacoquemecatl del Valle, alcaldía Benito Juárez, C.P. 03200, Ciudad de México, México. Privacy and support: overseer@roadmap2u.com."
          ]
        },
        {
          "title": "Data and purposes",
          "paragraphs": [
            "Accounts use email, identifier, username, display name and access attributes for registration, authentication, recovery, security and requests for assistance. Signing in or out never erases your device forest.",
            "If you authorize cloud storage, the trees, branches, notes, check-ins, sessions, harvests and preserves you sync are stored to save and recover your own forest across devices. Notes and check-ins may reveal sensitive data, including health or beliefs. Storing and syncing them requires your express authorization, separate from account terms. You can use your local forest without authorizing this sync.",
            "We retain evidence of privacy decisions —subject, text, language, version, date and revision— to apply and substantiate your choices. RoadMap2U has no advertising, analytics or trackers and does not sell your forest content."
          ]
        },
        {
          "title": "Private adolescent accounts",
          "paragraphs": [
            "The ages-12-to-17 modality uses an authenticated parent or guardian declaration: confirmed email, recent sign-in, admitted adult account and current Premium. We record declared full name and relationship, responsible account and exact recipient identifiers, date of majority, text, language, versions and decision evidence. This signup does not verify identity, parentage or guardianship documents. Do not send identity documents in your notes or the app form.",
            "The adolescent receives their own explanation and separately decides whether to use cloud. Their forest permits no friendships, visits, user discovery or connections to other forests. Representative authorization grants no everyday forest reading or export, family coverage or Premium.",
            "Adolescent cloud capacity depends on that representative’s current Premium; the forest keeps Free limits. If that capacity ends, cloud stops without erasing the account or forest. Downloading data and exercising privacy rights do not require Premium.",
            "At 18, account and data remain; parental authorization ends and personal adult acceptance and cloud authorization are required, along with independent capacity where applicable. Social restrictions remain. Disputes and changes of representative are handled through verified support; there is no automatic transfer."
          ]
        },
        {
          "title": "Device, cloud and providers",
          "paragraphs": [
            "The forest works locally. Authentication and account management do use remote services; declining sync does not make the account anonymous. Cloud uses Amazon Web Services (AWS): Cognito, API Gateway, Lambda and DynamoDB, with regional services in the United States. The web app is delivered through CloudFront. These providers support and protect the service, so processing takes place outside Mexico.",
            "Adult social functions operate only when enabled and authorized. Visits have a limited view and exclude check-ins and sessions. Private adolescent accounts block all such access, including a representative with previous links. Downloaded files are under your control.",
            "Forest content is not shared for advertising or purposes unrelated to the service. Disclosure required by a legal obligation or competent authority is limited to the relevant data and scope."
          ]
        },
        {
          "title": "Your choices and rights",
          "paragraphs": [
            "You can stay on this device, authorize cloud or later withdraw authorization in My privacy. Disconnecting a device only stops its sync. Withdrawal stops new cloud operations and preserves existing copies until the appropriate erasure procedure.",
            "You can download your remote data and request remote forest erasure without Premium or a mandatory download. Account and device forest remain. Account closure, local copies and downloaded files have different scopes.",
            "Access, correction, erasure, objection, withdrawal or restriction requests are received at overseer@roadmap2u.com. Provide your name, response channel, account and request; for correction, describe the change you seek. Identity and, where relevant, representation are verified through a private channel agreed for the case. Do not send passwords, MFA or tokens.",
            "Requests concerning adolescents do not infer authority from knowing a username or receiving an email. A determination is communicated within a maximum of 20 business days after receiving the request and, if applicable, carried out within the following 15 business days. Justified extensions are communicated under applicable rules. Available electronic delivery is free."
          ]
        },
        {
          "title": "Retention, erasure and security",
          "paragraphs": [
            "Account and forest remain while their purpose continues and, for cloud, authorization applies. Erasure is processed in batches and verified. A specific preservation obligation records reason, category, scope, review and expiry; it does not retain everything indefinitely.",
            "The operating schedule distinguishes ordinary records and logs of up to 30 days, recovery points of up to 35 days and minimal restore exclusions for 36 days after erasure. These are technical choices, not universal statutory periods. Consent and verification evidence is retained according to its purpose; any tax or commercial obligation has its own scope and rule.",
            "Infrastructure uses HTTPS, DynamoDB encryption at rest, account authorization and limited administrative permissions. Restoring forest content cannot revive withdrawn authorizations or excluded data: it is checked against the independent privacy record. AWS encryption does not by itself protect downloaded files or replace security on your device."
          ]
        },
        {
          "title": "Notice changes",
          "paragraphs": [
            "The current notice is published at /privacy and terms at /terms. Their versions are identified in your decision evidence. Changes of purpose or consent require information and a new decision where applicable. We retain the text, language, version and date you actually accepted."
          ]
        }
      ]
    },
    "terms": {
      "title": "Terms of use",
      "intro": "RoadMap2U is a personal organization tool: your goals grow as trees, branches and next steps. It does not provide medical diagnosis or treatment or replace professional care.",
      "sections": [
        {
          "title": "Account and modality",
          "paragraphs": [
            "Adults choose their modality and accept these terms. Adolescents aged 12 to 17 use a private account after an authenticated parent or guardian declaration, together with their own acceptance and confirmed email. The authorizing person truthfully declares their name, relationship and authority to represent them; the app checks their account, not civil documents. This modality does not offer registration for children under 12.",
            "Each person protects their credentials and provides truthful account information. A private adolescent account has no visits or friendships, and representative authorization does not open their notes. Local forest content remains when signing in, out or declining cloud."
          ]
        },
        {
          "title": "Cloud and capacity",
          "paragraphs": [
            "Sync requires current privacy authorization and the appropriate commercial capacity. Premium does not replace consent. Authorizing privacy does not grant Premium or family membership.",
            "Adolescent cloud is linked to the current Premium of the responsible account that recorded authorization and keeps Free limits: two active trees and ten visible branches per tree. Ending Premium or withdrawing either authorization stops new cloud operations and preserves data. This link does not give the adolescent personal Premium, social functions or family access.",
            "Family functions remain disabled for this release. Sponsored grants are free and are not sold. Payment, renewal, cancellation and refund conditions will be described before enabling purchases; this modality does not offer a purchase or activate Stripe."
          ]
        },
        {
          "title": "Privacy, closure and support",
          "paragraphs": [
            "Archiving an item, erasing a remote forest and closing an account are different operations. The privacy notice explains copies, retention, rights and exceptions. Erasure requires neither Premium nor a mandatory download.",
            "At 18, the private account and its data remain; parental authorization ends and personal adult acceptance is requested before continuing cloud. Social functions are not opened automatically.",
            "Help and complaints: overseer@roadmap2u.com. Adolescent requests use identity and representation verification appropriate to the case. Never share passwords, MFA or tokens."
          ]
        },
        {
          "title": "Availability and applicable rules",
          "paragraphs": [
            "Maintenance, connectivity or incidents may interrupt the service. Your local forest and any copies you choose to download help preserve your work; continuous cloud availability is not guaranteed. Remote access may be limited for security, requested closure or breach of these conditions, while preserving applicable privacy rights.",
            "Use the app for content you own or have the right to use, without violating third-party rights or attempting to access other accounts. These terms are interpreted under Mexican law and do not limit non-waivable privacy or consumer rights. Complaints may be submitted to the competent authority."
          ]
        }
      ]
    },
    "declaration": {
      "adult": "I am 18 or older.",
      "terms": "I have read and accept the RoadMap2U terms of use."
    },
    "cloud": {
      "title": "Your forest, your cloud choice",
      "body": "Your forest stays here on this device. If you connect it, RoadMap2U will store the trees, branches, notes, check-ins, sessions, harvests and preserves you sync in AWS, with regional services in the United States, so you can recover them across your devices.",
      "sensitive": "Notes and check-ins may contain intimate information such as health or beliefs. They serve your forest functions. You can stay on this device or later withdraw authorization from Privacy.",
      "authorization": "I expressly authorize Héctor Coronado, the controller of RoadMap2U, to store and synchronize my forest content, including notes, check-ins and sensitive information they voluntarily contain, for the functions described in the privacy notice."
    },
    "adolescent": {
      "version": "private-adolescent-2026-10-07-v2",
      "explanation": "My forest is private. It has no friendships, visits or connections to other forests. My parent or guardian authorizes my account and cloud; that authorization does not open my notes to them. Cloud needs their current Premium and my own authorization; my forest keeps Free limits. If that capacity ends, my data is not erased. I can stay on this device, download my data or withdraw my cloud choice. If my notes contain something intimate, including health or beliefs, it would also be stored when syncing.",
      "authorizationModel": "My confirmed email, a recent sign-in and current Premium allow this declaration to be recorded. RoadMap2U does not verify identity, parentage or guardianship documents during this signup. The adolescent then decides whether to accept their account and cloud storage.",
      "declaredName": "My declared full name",
      "declaredRelationship": "My relationship with the adolescent",
      "parentRelationship": "I am their father or mother",
      "legalGuardianRelationship": "I am their legal guardian",
      "understanding": "I understand how my private forest works and accept using my account with this explanation.",
      "representation": "I declare that I hold parental responsibility or legal guardianship for the named adolescent and have authority to represent them for this authorization.",
      "authorization": "I expressly authorize Héctor Coronado to process account data and sync the named adolescent’s forest, including sensitive data voluntarily included in notes and check-ins, for the purposes in the privacy notice. This authorization does not give me everyday access to their forest."
    }
  }
} as const;
