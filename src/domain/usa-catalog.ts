import type { Answer, FieldDefinition, FieldKind } from "./types.js";
import { addressPrompt } from "./address.js";

type Answers = Readonly<Record<string, Answer>>;
const always = () => true;
const yes = (id: string) => (answers: Answers) => answers[id]?.value === true;
const normalize = (value: unknown) => String(value ?? "").trim().toLocaleLowerCase("es").normalize("NFD").replace(/[\u0300-\u036f]/g, "");

export const USA_WORKFLOW_SCHEMA_FIELD = "workflow.usa_schema_version";
export const CURRENT_USA_WORKFLOW_SCHEMA_VERSION = 2;

function field(id: string, section: string, label: string, prompt: string, kind: FieldKind = "text", applies: (answers: Answers) => boolean = always): FieldDefinition {
  return { id, section, label, prompt, kind, required: true, order: 0, applies, forms: ["USA-DS160"] };
}

const legacyFields: FieldDefinition[] = [
  field("workflow.passport_uploaded", "Documentos", "Foto del pasaporte", "📘 *Comencemos con tu pasaporte*\n\nEnvíame una foto clara o un PDF de la página donde aparecen tus datos.\n\nSi no lo tienes en este momento, escribe *SALTAR* y quedará pendiente."),
  field("identity.full_name", "Datos personales", "Nombre completo", "👤 *Nombre del solicitante*\n\n¿Cuál es tu nombre completo, incluyendo todos tus nombres y apellidos, tal como aparece en tu pasaporte?"),
  field("contact.residential_address", "Datos personales", "Domicilio actual completo", "🏠 *Domicilio actual*\n\n¿Cuál es tu domicilio actual completo?\n\nIncluye: calle y número, colonia, delegación o municipio, ciudad, estado y código postal.\n\n_Ejemplo ficticio: Avenida de los Pinos 245, Colonia Costa Verde, Municipio de Boca del Río, Veracruz, C.P. 94294._"),
  field("contact.phone", "Datos personales", "Teléfono principal", "📱 *Teléfono de contacto*\n\n¿Cuál es tu número de teléfono celular con código de país?\n\n_Ejemplo: +52 55 1234 5678_", "phone"),
  field("contact.has_additional_phone", "Datos personales", "Tiene teléfono adicional", "📞 ¿Tienes otro número de teléfono que hayas utilizado? Responde Sí o No.", "yes_no"),
  field("contact.additional_phone", "Datos personales", "Teléfono adicional", "¿Cuál es ese número adicional? Incluye el código de país.\n\n_Ejemplo: +52 55 1234 5678_", "phone", yes("contact.has_additional_phone")),
  field("contact.email", "Datos personales", "Correo electrónico", "📧 ¿Cuál es tu correo electrónico principal?", "email"),
  field("contact.has_additional_email", "Datos personales", "Correo usado en últimos 5 años", "📧 Además de tu correo principal, ¿has utilizado algún otro correo electrónico durante los últimos 5 años? Responde Sí o No.", "yes_no"),
  field("contact.additional_email", "Datos personales", "Correo adicional", "¿Cuál es ese correo electrónico adicional? Escríbelo completo.", "email", yes("contact.has_additional_email")),
  field("social.has_social_media", "Redes sociales", "Usa redes sociales", "📱 ¿Utilizas Facebook, Twitter/X, Instagram u otra red social? Responde Sí o No.", "yes_no"),
  field("social.display_name", "Redes sociales", "Nombre en redes sociales", "¿Con qué nombre apareces normalmente en tus redes sociales?", "text", yes("social.has_social_media")),
  field("social.facebook", "Redes sociales", "Facebook", "¿Cuál es tu nombre de usuario o enlace de Facebook? Si no usas Facebook, escribe SALTAR.", "text", yes("social.has_social_media")),
  field("social.twitter", "Redes sociales", "Twitter/X", "¿Cuál es tu nombre de usuario o enlace de Twitter/X? Si no lo usas, escribe SALTAR.", "text", yes("social.has_social_media")),
  field("social.instagram", "Redes sociales", "Instagram", "¿Cuál es tu nombre de usuario o enlace de Instagram? Si no lo usas, escribe SALTAR.", "text", yes("social.has_social_media")),
  field("employment.company", "Trabajo", "Empresa", "¿Cuál es el nombre completo de la empresa donde trabajas o trabajaste?"),
  field("employment.from", "Trabajo", "Fecha de ingreso", "¿En qué fecha ingresaste? Usa DD/MM/AAAA.", "date"),
  field("employment.address", "Trabajo", "Dirección de la empresa", "🏢 ¿Cuál es la dirección completa de la empresa?\n\nIncluye calle y número, colonia, municipio, ciudad, estado y código postal.\n\n_Ejemplo ficticio: Avenida de los Pinos 245, Colonia Costa Verde, Municipio de Boca del Río, Veracruz, C.P. 94294._"),
  field("employment.duties", "Trabajo", "Actividades laborales", "Describe con tus propias palabras qué haces o hacías dentro de la empresa."),
  field("education.level", "Educación", "Último nivel de estudios", "🎓 *Estudios*\n\n¿Cuál es tu último nivel de estudios?\n\n_Ejemplos: secundaria, preparatoria, carrera técnica, licenciatura, maestría o doctorado._"),
  field("education.school", "Educación", "Escuela", "¿Cuál es el nombre completo de la escuela o institución donde cursaste ese nivel de estudios?"),
  field("education.from", "Educación", "Inicio de estudios", "¿En qué mes y año comenzaste esos estudios? Usa MM/AAAA.", "year_month"),
  field("education.until", "Educación", "Fin de estudios", "¿En qué mes y año terminaste? Usa MM/AAAA. Si todavía estudias ahí, escribe ACTUAL.", "year_month"),
  field("education.program", "Educación", "Carrera", "¿Cuál fue tu carrera, especialidad o área de estudio? Si no aplica para ese nivel, escribe SALTAR."),
  field("visit.destination", "Viaje a Estados Unidos", "Destino", "¿A qué ciudad o parte de Estados Unidos piensas viajar?"),
  field("visit.address", "Viaje a Estados Unidos", "Dirección del destino", "📍 ¿Cuál es la dirección completa donde te hospedarás o permanecerás en Estados Unidos?\n\nIncluye calle y número, ciudad, estado y código postal.\n\n_Ejemplo ficticio: 1450 Lakeview Avenue, Orlando, Florida, C.P. 32801._"),
  field("visit.phone", "Viaje a Estados Unidos", "Teléfono del destino", "¿Cuál es el teléfono del hotel, domicilio o contacto en tu destino? Incluye el código de país.\n\n_Ejemplo: +1 305 555 0123_", "phone"),
  field("relative.has_us_citizen", "Familiar en Estados Unidos", "Tiene familiar ciudadano", "¿Tienes algún familiar que sea ciudadano de Estados Unidos? Responde Sí o No.", "yes_no"),
  field("relative.full_name", "Familiar en Estados Unidos", "Nombre del familiar", "¿Cuál es el nombre completo de tu familiar?", "text", yes("relative.has_us_citizen")),
  field("relative.address", "Familiar en Estados Unidos", "Dirección del familiar", "¿Cuál es la dirección completa de tu familiar? Incluye calle y número, ciudad, estado y código postal.", "text", yes("relative.has_us_citizen")),
  field("relative.phone", "Familiar en Estados Unidos", "Teléfono del familiar", "¿Cuál es el teléfono de tu familiar, incluyendo el código de país?", "phone", yes("relative.has_us_citizen")),
  field("relative.email", "Familiar en Estados Unidos", "Correo del familiar", "¿Cuál es el correo electrónico completo de tu familiar?", "email", yes("relative.has_us_citizen")),
  field("relative.relationship", "Familiar en Estados Unidos", "Vínculo familiar", "¿Qué vínculo familiar tiene contigo?", "text", yes("relative.has_us_citizen")),
  field("mother.full_name", "Padres", "Nombre de la madre", "¿Cuál es el nombre completo de tu mamá?"),
  field("mother.address", "Padres", "Dirección de la madre", "¿Cuál es la dirección actual completa de tu mamá?"),
  field("mother.birth_date", "Padres", "Nacimiento de la madre", "¿Cuál es la fecha de nacimiento de tu mamá? Usa DD/MM/AAAA.", "date"),
  field("mother.occupation", "Padres", "Ocupación de la madre", "¿A qué se dedica tu mamá en México?"),
  field("father.full_name", "Padres", "Nombre del padre", "¿Cuál es el nombre completo de tu papá?"),
  field("father.address", "Padres", "Dirección del padre", "¿Cuál es la dirección actual completa de tu papá?"),
  field("father.birth_date", "Padres", "Nacimiento del padre", "¿Cuál es la fecha de nacimiento de tu papá? Usa DD/MM/AAAA.", "date"),
  field("father.occupation", "Padres", "Ocupación del padre", "¿A qué se dedica tu papá en México? Si ha fallecido, indícalo aquí escribiendo *FALLECIDO*."),
  field("language.has_other", "Antecedentes", "Habla otro idioma", "Además de español, ¿hablas algún otro idioma? Responde Sí o No.", "yes_no"),
  field("language.other", "Antecedentes", "Otro idioma", "¿Qué otro idioma hablas?", "text", yes("language.has_other")),
  field("travel.has_foreign_travel", "Antecedentes", "Ha viajado al extranjero", "¿Has viajado al extranjero? Responde Sí o No.", "yes_no"),
  field("travel.countries", "Antecedentes", "Países visitados", "Menciona todos los países que has visitado, separados por comas y en un solo mensaje.\n\n_Ejemplo: Canadá, Estados Unidos, Francia, España_", "text", yes("travel.has_foreign_travel")),
  field("deportation.has_been_deported", "Antecedentes", "Ha sido deportado", "¿Te han deportado de algún país? Responde Sí o No.", "yes_no"),
  field("deportation.detail", "Antecedentes", "Detalle de deportación", "Indica de qué país y cualquier detalle necesario.", "text", yes("deportation.has_been_deported")),
  field("visa.has_applied_before", "Antecedentes", "Solicitud anterior", "¿Has solicitado anteriormente una visa americana? Responde Sí o No.", "yes_no"),
  field("visa.previous_application_date", "Antecedentes", "Fecha de solicitud anterior", "¿Cuándo la solicitaste? Usa DD/MM/AAAA.", "date", yes("visa.has_applied_before")),
  field("workflow.correction_notes", "Cierre", "Correcciones", "📝 Revisión final: si algún dato es incorrecto, descríbelo junto con la corrección. Si todo está bien, escribe TODO CORRECTO."),
];

function v2field(
  id: string,
  section: string,
  label: string,
  prompt: string,
  kind: FieldKind = "text",
  options: { required?: boolean; applies?: (answers: Answers) => boolean } = {},
): FieldDefinition {
  return { id, section, label, prompt, kind, required: options.required ?? true, order: 0, applies: options.applies ?? always, forms: ["USA-DS160"] };
}

const hasEducation = (answers: Answers) => {
  const value = answers["education.level"];
  if (value?.status !== "CONFIRMED") return false;
  return !/^(?:sin estudios|ninguno|ninguna|no estudie|no estudie formalmente|no tengo estudios)$/.test(normalize(value.value));
};
const hasWork = yes("employment.has_current_or_previous");
const previousWork = (answers: Answers) => hasWork(answers) && answers["employment.is_current"]?.value === false;
const hasSocial = yes("social.has_social_media");
const usesPlatform = (pattern: RegExp) => (answers: Answers) => hasSocial(answers) && pattern.test(normalize(answers["social.platforms"]?.value));
const parentKnownAndLiving = (id: "mother.full_name" | "father.full_name") => (answers: Answers) => {
  const answer = answers[id];
  if (answer?.status !== "CONFIRMED") return false;
  return !/(?:desconocid|fallecid|finad|difunt|murio|muert)/.test(normalize(answer.value));
};

const fieldsV2: FieldDefinition[] = [
  v2field("workflow.passport_uploaded", "Documentos", "Foto del pasaporte", "📘 *Comencemos con tu pasaporte*\n\nEnvíame una foto clara o un PDF de la página donde aparecen tus datos.\n\nSi no lo tienes en este momento, escribe *SALTAR* y quedará pendiente."),
  v2field("identity.full_name", "Datos personales", "Nombre completo", "👤 *Nombre del solicitante*\n\n¿Cuál es tu nombre completo, incluyendo todos tus nombres y apellidos, tal como aparece en tu pasaporte?"),
  v2field("identity.birth_date", "Datos del pasaporte", "Fecha de nacimiento", "¿Cuál es tu fecha de nacimiento? Usa DD/MM/AAAA.", "date"),
  v2field("identity.birth_city", "Datos del pasaporte", "Ciudad de nacimiento", "¿En qué ciudad naciste?"),
  v2field("identity.birth_country", "Datos del pasaporte", "País de nacimiento", "¿En qué país naciste?"),
  v2field("passport.issuing_country", "Datos del pasaporte", "País emisor", "¿Qué país emitió tu pasaporte?"),
  v2field("passport.issue_date", "Datos del pasaporte", "Fecha de emisión", "¿Cuál es la fecha de emisión de tu pasaporte? Usa DD/MM/AAAA.", "date"),
  v2field("passport.expiry_date", "Datos del pasaporte", "Fecha de vencimiento", "¿Cuál es la fecha de vencimiento de tu pasaporte? Usa DD/MM/AAAA.", "date"),
  v2field("contact.residential_address", "Datos personales", "Domicilio actual completo", "🏠 *Domicilio actual*\n\n¿Cuál es tu domicilio actual completo?\n\nIncluye: calle y número, colonia, delegación o municipio, ciudad, estado y código postal.\n\n_Ejemplo ficticio: Avenida de los Pinos 245, Colonia Costa Verde, Municipio de Boca del Río, Veracruz, C.P. 94294._"),
  v2field("contact.phone", "Datos personales", "Teléfono principal", "📱 ¿Cuál es tu número de teléfono celular con código de país?\n\n_Ejemplo: +52 55 1234 5678_", "phone"),
  v2field("contact.has_additional_phone", "Datos personales", "Tiene teléfono adicional", "📞 ¿Tienes otro número de teléfono que hayas utilizado? Responde Sí o No.", "yes_no"),
  v2field("contact.additional_phone", "Datos personales", "Teléfono adicional", "¿Cuál es ese número adicional? Incluye el código de país.\n\n_Ejemplo: +52 55 1234 5678_", "phone", { applies: yes("contact.has_additional_phone") }),
  v2field("contact.email", "Datos personales", "Correo electrónico", "📧 ¿Cuál es tu correo electrónico principal?", "email"),
  v2field("contact.has_additional_email", "Datos personales", "Correo usado en últimos 5 años", "📧 Además de tu correo principal, ¿has utilizado algún otro correo electrónico durante los últimos 5 años? Responde Sí o No.", "yes_no"),
  v2field("contact.additional_email", "Datos personales", "Correo adicional", "¿Cuál es ese correo electrónico adicional? Escríbelo completo.", "email", { applies: yes("contact.has_additional_email") }),
  v2field("social.has_social_media", "Redes sociales", "Usa redes sociales", "📱 ¿Utilizas Facebook, Twitter/X, Instagram u otra red social? Responde Sí o No.", "yes_no"),
  v2field("social.platforms", "Redes sociales", "Plataformas utilizadas", "Menciona qué redes sociales utilizas, separadas por comas.\n\n_Ejemplo: Facebook, Instagram_", "text", { applies: hasSocial }),
  v2field("social.display_name", "Redes sociales", "Nombre en redes sociales", "¿Con qué nombre apareces normalmente en tus redes sociales?", "text", { applies: hasSocial }),
  v2field("social.facebook", "Redes sociales", "Facebook", "¿Cuál es tu nombre de usuario o enlace de Facebook?", "text", { applies: usesPlatform(/facebook/) }),
  v2field("social.twitter", "Redes sociales", "Twitter/X", "¿Cuál es tu nombre de usuario o enlace de Twitter/X?", "text", { applies: usesPlatform(/twitter|(^|\W)x($|\W)/) }),
  v2field("social.instagram", "Redes sociales", "Instagram", "¿Cuál es tu nombre de usuario o enlace de Instagram?", "text", { applies: usesPlatform(/instagram/) }),
  v2field("employment.has_current_or_previous", "Trabajo", "Tiene trabajo actual o anterior", "💼 ¿Trabajas actualmente o has tenido un trabajo anterior que debamos registrar? Responde Sí o No.", "yes_no"),
  v2field("employment.is_current", "Trabajo", "Es trabajo actual", "¿Es tu trabajo actual? Responde Sí o No.", "yes_no", { applies: hasWork }),
  v2field("employment.company", "Trabajo", "Empresa", "¿Cuál es el nombre completo de la empresa, negocio o institución?", "text", { applies: hasWork }),
  v2field("employment.position", "Trabajo", "Puesto", "¿Cuál es o era tu puesto, ocupación o actividad principal?", "text", { applies: hasWork }),
  v2field("employment.from", "Trabajo", "Fecha de ingreso", "¿En qué mes y año comenzaste? Usa MM/AAAA.", "year_month", { applies: hasWork }),
  v2field("employment.until", "Trabajo", "Fecha de término", "¿En qué mes y año terminaste? Usa MM/AAAA.", "year_month", { applies: previousWork }),
  v2field("employment.address", "Trabajo", "Dirección de la empresa", "🏢 ¿Cuál es la dirección completa de la empresa?\n\nIncluye calle y número, colonia, municipio, ciudad, estado y código postal.\n\n_Ejemplo ficticio: Avenida de los Pinos 245, Colonia Costa Verde, Municipio de Boca del Río, Veracruz, C.P. 94294._", "text", { applies: hasWork }),
  v2field("employment.duties", "Trabajo", "Actividades laborales", "Describe con tus propias palabras qué haces o hacías dentro de la empresa.", "text", { applies: hasWork }),
  v2field("education.level", "Educación", "Último nivel de estudios", "🎓 *Estudios*\n\n¿Cuál es tu último nivel de estudios?\n\n_Ejemplos: sin estudios, secundaria, preparatoria, carrera técnica, licenciatura, maestría o doctorado._"),
  v2field("education.school", "Educación", "Escuela", "¿Cuál es el nombre completo de la escuela o institución donde cursaste ese nivel de estudios?", "text", { applies: hasEducation }),
  v2field("education.from", "Educación", "Inicio de estudios", "¿En qué mes y año comenzaste esos estudios? Usa MM/AAAA.", "year_month", { applies: hasEducation }),
  v2field("education.until", "Educación", "Fin de estudios", "¿En qué mes y año terminaste? Usa MM/AAAA. Si todavía estudias ahí, escribe ACTUAL.", "year_month", { applies: hasEducation }),
  v2field("education.program", "Educación", "Carrera", "¿Cuál fue tu carrera, especialidad o área de estudio? Si no aplica, escribe SALTAR.", "text", { required: false, applies: hasEducation }),
  v2field("visit.destination", "Viaje a Estados Unidos", "Destino", "¿A qué ciudad o parte de Estados Unidos piensas viajar?"),
  v2field("visit.address", "Viaje a Estados Unidos", "Dirección del destino", "📍 ¿Cuál es la dirección completa donde te hospedarás o permanecerás en Estados Unidos?\n\nIncluye calle y número, ciudad, estado y código postal.\n\n_Ejemplo ficticio: 1450 Lakeview Avenue, Orlando, Florida, C.P. 32801._"),
  v2field("visit.phone", "Viaje a Estados Unidos", "Teléfono del destino", "¿Cuál es el teléfono del hotel, domicilio o contacto en tu destino? Incluye el código de país.\n\n_Ejemplo: +1 305 555 0123_", "phone"),
  v2field("relative.has_us_citizen", "Familiar en Estados Unidos", "Tiene familiar ciudadano", "¿Tienes algún familiar que sea ciudadano de Estados Unidos? Responde Sí o No.", "yes_no"),
  v2field("relative.full_name", "Familiar en Estados Unidos", "Nombre del familiar", "¿Cuál es el nombre completo de tu familiar?", "text", { applies: yes("relative.has_us_citizen") }),
  v2field("relative.address", "Familiar en Estados Unidos", "Dirección del familiar", "¿Cuál es la dirección completa de tu familiar? Incluye calle y número, ciudad, estado y código postal.", "text", { applies: yes("relative.has_us_citizen") }),
  v2field("relative.phone", "Familiar en Estados Unidos", "Teléfono del familiar", "¿Cuál es el teléfono de tu familiar, incluyendo el código de país?", "phone", { applies: yes("relative.has_us_citizen") }),
  v2field("relative.email", "Familiar en Estados Unidos", "Correo del familiar", "¿Cuál es el correo electrónico completo de tu familiar?", "email", { applies: yes("relative.has_us_citizen") }),
  v2field("relative.relationship", "Familiar en Estados Unidos", "Vínculo familiar", "¿Qué vínculo familiar tiene contigo?", "text", { applies: yes("relative.has_us_citizen") }),
  v2field("mother.full_name", "Padres", "Nombre de la madre", "¿Cuál es el nombre completo de tu mamá? Si no la conoces, escribe NO SÉ."),
  v2field("mother.address", "Padres", "Dirección de la madre", "¿Cuál es la dirección actual completa de tu mamá?", "text", { applies: parentKnownAndLiving("mother.full_name") }),
  v2field("mother.birth_date", "Padres", "Nacimiento de la madre", "¿Cuál es la fecha de nacimiento de tu mamá? Usa DD/MM/AAAA.", "date", { applies: parentKnownAndLiving("mother.full_name") }),
  v2field("mother.occupation", "Padres", "Ocupación de la madre", "¿A qué se dedica tu mamá en México? Si ha fallecido, indícalo escribiendo FALLECIDA.", "text", { applies: parentKnownAndLiving("mother.full_name") }),
  v2field("father.full_name", "Padres", "Nombre del padre", "¿Cuál es el nombre completo de tu papá? Si no lo conoces, escribe NO SÉ. Si falleció, indícalo aquí escribiendo FALLECIDO."),
  v2field("father.address", "Padres", "Dirección del padre", "¿Cuál es la dirección actual completa de tu papá?", "text", { applies: parentKnownAndLiving("father.full_name") }),
  v2field("father.birth_date", "Padres", "Nacimiento del padre", "¿Cuál es la fecha de nacimiento de tu papá? Usa DD/MM/AAAA.", "date", { applies: parentKnownAndLiving("father.full_name") }),
  v2field("father.occupation", "Padres", "Ocupación del padre", "¿A qué se dedica tu papá en México? Si ha fallecido, indícalo escribiendo FALLECIDO.", "text", { applies: parentKnownAndLiving("father.full_name") }),
  v2field("language.has_other", "Antecedentes", "Habla otro idioma", "Además de español, ¿hablas algún otro idioma? Responde Sí o No.", "yes_no"),
  v2field("language.other", "Antecedentes", "Otro idioma", "¿Qué otro idioma hablas?", "text", { applies: yes("language.has_other") }),
  v2field("travel.has_foreign_travel", "Antecedentes", "Ha viajado al extranjero", "¿Has viajado al extranjero? Responde Sí o No.", "yes_no"),
  v2field("travel.countries", "Antecedentes", "Países visitados", "Menciona todos los países que has visitado, separados por comas y en un solo mensaje.\n\n_Ejemplo: Canadá, Estados Unidos, Francia, España_", "text", { applies: yes("travel.has_foreign_travel") }),
  v2field("deportation.has_been_deported", "Antecedentes", "Ha sido deportado", "¿Te han deportado de algún país? Responde Sí o No.", "yes_no"),
  v2field("deportation.detail", "Antecedentes", "Detalle de deportación", "Indica de qué país y cualquier detalle necesario.", "text", { applies: yes("deportation.has_been_deported") }),
  v2field("visa.has_applied_before", "Antecedentes", "Solicitud anterior", "¿Has solicitado anteriormente una visa americana? Responde Sí o No.", "yes_no"),
  v2field("visa.previous_application_date", "Antecedentes", "Fecha de solicitud anterior", "¿Cuándo la solicitaste? Usa DD/MM/AAAA.", "date", { applies: yes("visa.has_applied_before") }),
  v2field("workflow.correction_notes", "Cierre", "Correcciones", "📝 *Revisión final*\n\n¿Hubo algún dato que hayas escrito incorrectamente? Si todo está bien, escribe TODO CORRECTO."),
];

export function usaCatalogFor(answers: Answers): FieldDefinition[] {
  const version = Number(answers[USA_WORKFLOW_SCHEMA_FIELD]?.value ?? 1);
  const fields = version >= 2 ? fieldsV2 : legacyFields;
  return fields.filter((item) => item.applies(answers)).map((item, order) => ({ ...item, prompt: addressPrompt(item.prompt, item.id, answers), order }));
}

export function usaFieldById(id: string, answers: Answers): FieldDefinition | undefined {
  return usaCatalogFor(answers).find((item) => item.id === id);
}
