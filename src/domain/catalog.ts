import type { Answer, FieldDefinition, FieldKind } from "./types.js";
import { addressPrompt } from "./address.js";

type Answers = Readonly<Record<string, Answer>>;
const always = () => true;
const isYes = (fieldId: string) => (answers: Answers) => answers[fieldId]?.value === true;
const isNotReportedDeceased = (fieldId: string) => (answers: Answers) => answers[fieldId]?.value !== "FALLECIDO/A";

let order = 0;
const field = (
  id: string,
  section: string,
  label: string,
  prompt: string,
  kind: FieldKind = "text",
  options: { required?: boolean; applies?: (answers: Answers) => boolean; forms?: string[] } = {},
): FieldDefinition => ({
  id,
  section,
  label,
  prompt,
  kind,
  required: options.required ?? true,
  applies: options.applies ?? always,
  forms: options.forms ?? ["IMM5257"],
  order: order++,
});

const core: FieldDefinition[] = [
  field("workflow.passport_uploaded", "Inicio", "Pasaporte recibido", "Para comenzar, envíame una foto clara o un PDF de la página de datos de tu pasaporte. Si no lo tienes en este momento, escribe SALTAR y quedará pendiente.", "text", { forms: ["INTERNAL"] }),
  field("application.uci", "Inicio", "UCI", "Si alguna vez tuviste un número UCI de Canadá, escríbelo. Si no lo tienes o no lo conoces, escribe SALTAR.", "text", { required: false }),
  field("application.visa_type", "Inicio", "Tipo de visa", "¿El trámite es para una visa de visitante (turista) o una visa de tránsito?"),
  field("identity.full_name", "Datos personales", "Nombre completo", "¿Cuál es tu nombre completo, incluyendo todos tus nombres y apellidos, tal como aparece en tu pasaporte?", "text", { forms: ["IMM5257", "IMM5707"] }),
  field("identity.birth_date", "Datos personales", "Fecha de nacimiento", "¿Cuál es tu fecha de nacimiento? Usa DD/MM/AAAA.", "date", { forms: ["IMM5257", "IMM5707"] }),
  field("identity.birth_city", "Datos personales", "Ciudad de nacimiento", "¿En qué ciudad o pueblo naciste?"),
  field("identity.birth_country", "Datos personales", "País de nacimiento", "¿En qué país o territorio naciste?", "text", { forms: ["IMM5257", "IMM5707"] }),
  field("identity.citizenship", "Datos personales", "Ciudadanía", "¿Cuál es tu ciudadanía actual?"),

  field("passport.issuing_country", "Pasaporte", "País emisor", "¿Qué país o territorio emitió tu pasaporte?"),
  field("passport.issue_date", "Pasaporte", "Fecha de emisión", "¿Cuál es la fecha de emisión de tu pasaporte? Usa DD/MM/AAAA.", "date"),
  field("passport.expiry_date", "Pasaporte", "Fecha de vencimiento", "¿Cuál es la fecha de vencimiento de tu pasaporte? Usa DD/MM/AAAA.", "date"),

  field("residence.current_country", "Residencia", "País de residencia", "¿En qué país vives actualmente?"),
  field("residence.current_status", "Residencia", "Estatus actual", "¿Qué estatus tienes ahí? Por ejemplo: ciudadanía, residencia permanente, trabajo, estudios o visita."),
  field("residence.other_country_5y", "Residencia", "Otra residencia en 5 años", "En los últimos 5 años, ¿viviste más de 6 meses en otro país? Sí o No.", "yes_no"),
  field("residence.other_country", "Residencia", "Otro país", "¿En qué otro país viviste?", "text", { applies: isYes("residence.other_country_5y") }),
  field("residence.other_status", "Residencia", "Estatus en otro país", "¿Qué estatus tenías en ese país?", "text", { applies: isYes("residence.other_country_5y") }),
  field("residence.other_period", "Residencia", "Periodo en otro país", "¿Desde qué fecha hasta qué fecha viviste ahí?", "text", { applies: isYes("residence.other_country_5y") }),
  field("residence.applying_from_current", "Residencia", "Solicita desde residencia actual", "¿Estás haciendo esta solicitud desde el mismo país donde resides actualmente? Sí o No.", "yes_no"),
  field("residence.application_country", "Residencia", "País desde donde solicita", "¿Desde qué país estás haciendo la solicitud?", "text", { applies: (a) => a["residence.applying_from_current"]?.value === false }),
  field("residence.application_status", "Residencia", "Estatus en país de solicitud", "¿Qué estatus tienes en ese país?", "text", { applies: (a) => a["residence.applying_from_current"]?.value === false }),

  field("contact.residential_address", "Residencia", "Domicilio actual completo", "¿Cuál es tu domicilio actual completo? Escríbelo en este orden: nombre de la calle y número, colonia, delegación o municipio, ciudad y código postal. Ejemplo ficticio: Avenida de los Pinos 245, Colonia Costa Verde, Municipio de Boca del Río, Veracruz, C.P. 94294."),
  field("contact.mailing_address", "Residencia", "Dirección postal completa", "¿Cuál es tu dirección completa para recibir correspondencia?"),

  field("family.marital_status", "Familia", "Estado civil", "¿Cuál es tu estado civil actual?", "text", { forms: ["IMM5257", "IMM5707"] }),
  field("family.has_partner", "Familia", "Tiene pareja", "¿Tienes esposo/a, pareja de hecho o pareja conyugal actualmente? Sí o No.", "yes_no", { forms: ["IMM5257", "IMM5707"] }),
  field("partner.full_name", "Familia", "Nombre completo de pareja", "¿Cuál es el nombre completo de tu pareja, incluyendo todos sus nombres y apellidos?", "text", { applies: isYes("family.has_partner"), forms: ["IMM5257", "IMM5707"] }),
  field("partner.birth_date", "Familia", "Nacimiento de pareja", "¿Cuál es su fecha de nacimiento? Usa DD/MM/AAAA.", "date", { applies: isYes("family.has_partner"), forms: ["IMM5707"] }),
  field("partner.birth_country", "Familia", "País de nacimiento de pareja", "¿En qué país nació?", "text", { applies: isYes("family.has_partner"), forms: ["IMM5707"] }),
  field("partner.address", "Familia", "Dirección de pareja", "¿Cuál es su dirección actual completa?", "text", { applies: isYes("family.has_partner"), forms: ["IMM5707"] }),
  field("partner.occupation", "Familia", "Ocupación de pareja", "¿Cuál es su ocupación actual?", "text", { applies: isYes("family.has_partner"), forms: ["IMM5707"] }),
  field("partner.accompanies", "Familia", "Pareja acompaña", "¿Tu pareja te acompañará a Canadá? Sí o No.", "yes_no", { applies: isYes("family.has_partner"), forms: ["IMM5707"] }),
  field("partner.present_at_ceremony", "Familia", "Presente en ceremonia", "¿Tu pareja estuvo físicamente presente en la ceremonia de matrimonio? Sí o No.", "yes_no", { required: false, applies: isYes("family.has_partner"), forms: ["IMM5707"] }),
  field("family.had_previous_partner", "Familia", "Relación anterior", "Antes de tu relación actual, ¿estuviste casado/a o en unión de hecho? Sí o No.", "yes_no"),
  field("previous_partner.full_name", "Familia", "Nombre completo de pareja anterior", "¿Cuál es el nombre completo de esa persona, incluyendo todos sus nombres y apellidos?", "text", { applies: isYes("family.had_previous_partner") }),
  field("previous_partner.birth_date", "Familia", "Nacimiento de pareja anterior", "¿Cuál es su fecha de nacimiento? Usa DD/MM/AAAA.", "date", { applies: isYes("family.had_previous_partner") }),
  field("previous_partner.relationship", "Familia", "Tipo de relación anterior", "¿Fue matrimonio o unión de hecho?", "text", { applies: isYes("family.had_previous_partner") }),
  field("previous_partner.from", "Familia", "Inicio de relación anterior", "¿Cuándo comenzó esa relación? Usa DD/MM/AAAA.", "date", { applies: isYes("family.had_previous_partner") }),
  field("previous_partner.until", "Familia", "Fin de relación anterior", "¿Cuándo terminó? Usa DD/MM/AAAA.", "date", { applies: isYes("family.had_previous_partner") }),

  field("parent1.full_name", "Familia", "Nombre completo de primer padre/madre", "Ahora tus padres. ¿Cuál es el nombre completo de tu primer padre o madre, incluyendo todos sus nombres y apellidos?", "text", { forms: ["IMM5707"] }),
  field("parent1.birth_date", "Familia", "Nacimiento de primer padre/madre", "¿Cuál es su fecha de nacimiento? Usa DD/MM/AAAA.", "date", { forms: ["IMM5707"] }),
  field("parent1.birth_country", "Familia", "País natal de primer padre/madre", "¿En qué país nació?", "text", { forms: ["IMM5707"] }),
  field("parent1.marital_status", "Familia", "Estado civil de primer padre/madre", "¿Cuál es el estado civil actual de tu primer padre o madre? Si falleció, indícalo aquí como \"Fallecido\".", "text", { forms: ["IMM5707"] }),
  field("parent1.address", "Familia", "Dirección de primer padre/madre", "¿Cuál es su dirección actual?", "text", { applies: isNotReportedDeceased("parent1.marital_status"), forms: ["IMM5707"] }),
  field("parent1.occupation", "Familia", "Ocupación de primer padre/madre", "¿Cuál es su ocupación actual? Si está retirado/a, indícalo.", "text", { applies: isNotReportedDeceased("parent1.marital_status"), forms: ["IMM5707"] }),
  field("parent1.accompanies", "Familia", "Primer padre/madre acompaña", "¿Te acompañará a Canadá? Sí o No.", "yes_no", { applies: isNotReportedDeceased("parent1.marital_status"), forms: ["IMM5707"] }),

  field("parent2.full_name", "Familia", "Nombre completo de segundo padre/madre", "¿Cuál es el nombre completo de tu segundo padre o madre, incluyendo todos sus nombres y apellidos?", "text", { forms: ["IMM5707"] }),
  field("parent2.birth_date", "Familia", "Nacimiento de segundo padre/madre", "¿Cuál es su fecha de nacimiento? Usa DD/MM/AAAA.", "date", { forms: ["IMM5707"] }),
  field("parent2.birth_country", "Familia", "País natal de segundo padre/madre", "¿En qué país nació?", "text", { forms: ["IMM5707"] }),
  field("parent2.marital_status", "Familia", "Estado civil de segundo padre/madre", "¿Cuál es el estado civil actual de tu segundo padre o madre? Si falleció, indícalo aquí como \"Fallecido\".", "text", { forms: ["IMM5707"] }),
  field("parent2.address", "Familia", "Dirección de segundo padre/madre", "¿Cuál es su dirección actual?", "text", { applies: isNotReportedDeceased("parent2.marital_status"), forms: ["IMM5707"] }),
  field("parent2.occupation", "Familia", "Ocupación de segundo padre/madre", "¿Cuál es su ocupación actual? Si está retirado/a, indícalo.", "text", { applies: isNotReportedDeceased("parent2.marital_status"), forms: ["IMM5707"] }),
  field("parent2.accompanies", "Familia", "Segundo padre/madre acompaña", "¿Te acompañará a Canadá? Sí o No.", "yes_no", { applies: isNotReportedDeceased("parent2.marital_status"), forms: ["IMM5707"] }),

  field("children.count", "Familia", "Cantidad de hijos", "¿Cuántos hijos tienes? Incluye biológicos, adoptados, hijastros y de relaciones anteriores. Escribe 0 si no tienes.", "integer", { forms: ["IMM5707"] }),

  field("contact.email", "Contacto", "Correo electrónico", "¿Cuál es tu correo electrónico?", "email"),
  field("contact.phone", "Contacto", "Teléfono principal", "¿Cuál es tu teléfono principal con código de país?", "phone"),
  field("contact.phone_type", "Contacto", "Tipo de teléfono", "¿Ese teléfono es celular, casa o trabajo?"),

  field("language.english", "Idiomas", "Inglés", "¿Puedes comunicarte en inglés? Sí o No.", "yes_no"),
  field("language.french", "Idiomas", "Francés", "¿Puedes comunicarte en francés? Sí o No.", "yes_no"),
  field("language.official_test", "Idiomas", "Examen oficial", "¿Has tomado un examen oficial de inglés o francés? Sí o No.", "yes_no"),

  field("education.has_postsecondary", "Educación", "Estudios postsecundarios", "¿Cursaste estudios después de preparatoria o bachillerato? Sí o No.", "yes_no"),
  field("education.from", "Educación", "Inicio de estudios", "¿En qué mes y año comenzaste esos estudios? Usa MM/AAAA.", "year_month", { applies: isYes("education.has_postsecondary") }),
  field("education.until", "Educación", "Fin de estudios", "¿En qué mes y año terminaste? Usa MM/AAAA.", "year_month", { applies: isYes("education.has_postsecondary") }),
  field("education.field", "Educación", "Área de estudio", "¿Cuál fue tu carrera o área de estudio?", "text", { applies: isYes("education.has_postsecondary") }),
  field("education.school", "Educación", "Institución", "¿Cuál fue la escuela o institución?", "text", { applies: isYes("education.has_postsecondary") }),
  field("education.city", "Educación", "Ciudad de institución", "¿En qué ciudad está la institución?", "text", { applies: isYes("education.has_postsecondary") }),
  field("education.province", "Educación", "Estado o provincia de institución", "¿En qué estado o provincia? Si no aplica, escribe SALTAR.", "text", { required: false, applies: isYes("education.has_postsecondary") }),
  field("education.country", "Educación", "País de institución", "¿En qué país está?", "text", { applies: isYes("education.has_postsecondary") }),

  field("employment.count", "Empleo", "Cantidad de actividades", "Para cubrir los últimos 10 años sin huecos, ¿cuántos periodos necesitas registrar? Incluye trabajo, estudios, desempleo y cuidado del hogar.", "integer"),

  field("visit.purpose", "Viaje", "Propósito de visita", "¿Cuál es el propósito principal de tu visita a Canadá?"),
  field("visit.from", "Viaje", "Inicio de visita", "¿En qué fecha planeas llegar a Canadá? Usa DD/MM/AAAA.", "date"),
  field("visit.until", "Viaje", "Fin de visita", "¿En qué fecha planeas salir de Canadá? Usa DD/MM/AAAA.", "date"),
  field("visit.funds_cad", "Viaje", "Fondos disponibles", "¿Cuánto dinero tendrás disponible para tu estancia, en dólares canadienses?", "money"),
  field("visit.contact_name", "Viaje", "Persona o institución en Canadá", "¿Cuál es el nombre de la persona o institución que visitarás en Canadá?"),
  field("visit.contact_relationship", "Viaje", "Relación con contacto", "¿Qué relación tiene contigo?"),
  field("visit.contact_address", "Viaje", "Dirección del contacto", "¿Cuál es su dirección en Canadá?"),
  field("travel_history.has_travel", "Viajes anteriores", "Viajes fuera de ciudadanía/residencia", "Desde que cumpliste 18 años o durante los últimos 5 años, lo que sea más reciente: ¿viajaste a un país distinto al de tu ciudadanía o residencia actual? Sí o No.", "yes_no", { forms: ["IMM5257-SCHEDULE-1"] }),
  field("travel_history.count", "Viajes anteriores", "Cantidad de viajes", "¿Cuántos viajes distintos necesitas registrar?", "integer", { applies: isYes("travel_history.has_travel"), forms: ["IMM5257-SCHEDULE-1"] }),
];

function repeatedChildren(answers: Answers): FieldDefinition[] {
  const raw = answers["children.count"]?.value;
  const count = typeof raw === "number" ? Math.min(raw, 20) : 0;
  const result: FieldDefinition[] = [];
  for (let index = 1; index <= count; index++) {
    const p = `children.${index}`;
    const section = "Familia";
    result.push(
      field(`${p}.relationship`, section, `Relación hijo/a ${index}`, `Hijo/a ${index}: ¿qué relación tiene contigo (hijo/a, hijastro/a o adoptado/a)?`, "text", { forms: ["IMM5707"] }),
      field(`${p}.full_name`, section, `Nombre completo hijo/a ${index}`, `Hijo/a ${index}: ¿cuál es su nombre completo, incluyendo todos sus nombres y apellidos?`, "text", { forms: ["IMM5707"] }),
      field(`${p}.birth_date`, section, `Nacimiento hijo/a ${index}`, `Hijo/a ${index}: ¿cuál es su fecha de nacimiento? Usa DD/MM/AAAA.`, "date", { forms: ["IMM5707"] }),
      field(`${p}.birth_country`, section, `País natal hijo/a ${index}`, `Hijo/a ${index}: ¿en qué país nació?`, "text", { forms: ["IMM5707"] }),
      field(`${p}.marital_status`, section, `Estado civil hijo/a ${index}`, `Hijo/a ${index}: ¿cuál es su estado civil actual? Si falleció, indícalo aquí como \"Fallecido\".`, "text", { forms: ["IMM5707"] }),
      field(`${p}.address`, section, `Dirección hijo/a ${index}`, `Hijo/a ${index}: ¿cuál es su dirección actual?`, "text", { applies: isNotReportedDeceased(`${p}.marital_status`), forms: ["IMM5707"] }),
      field(`${p}.occupation`, section, `Ocupación hijo/a ${index}`, `Hijo/a ${index}: ¿cuál es su ocupación? Si es menor, puedes indicar estudiante o no aplica.`, "text", { applies: isNotReportedDeceased(`${p}.marital_status`), forms: ["IMM5707"] }),
      field(`${p}.accompanies`, section, `Hijo/a ${index} acompaña`, `Hijo/a ${index}: ¿te acompañará a Canadá? Sí o No.`, "yes_no", { applies: isNotReportedDeceased(`${p}.marital_status`), forms: ["IMM5707"] }),
    );
  }
  return result;
}

function repeatedEmployment(answers: Answers): FieldDefinition[] {
  const raw = answers["employment.count"]?.value;
  const count = typeof raw === "number" ? Math.min(raw, 20) : 0;
  const result: FieldDefinition[] = [];
  for (let index = 1; index <= count; index++) {
    const p = `employment.${index}`;
    result.push(
      field(`${p}.from`, "Empleo", `Inicio actividad ${index}`, `Actividad ${index}: ¿en qué mes y año comenzó? Usa MM/AAAA.`, "year_month"),
      field(`${p}.until`, "Empleo", `Fin actividad ${index}`, `Actividad ${index}: ¿en qué mes y año terminó? Si continúa, escribe ACTUAL.`, "year_month"),
      field(`${p}.activity`, "Empleo", `Actividad ${index}`, `Actividad ${index}: ¿cuál era tu ocupación o actividad?`),
      field(`${p}.organization`, "Empleo", `Organización ${index}`, `Actividad ${index}: ¿cuál era la empresa, institución o situación?`),
      field(`${p}.city`, "Empleo", `Ciudad actividad ${index}`, `Actividad ${index}: ¿en qué ciudad?`),
      field(`${p}.country`, "Empleo", `País actividad ${index}`, `Actividad ${index}: ¿en qué país?`),
      field(`${p}.province`, "Empleo", `Provincia actividad ${index}`, `Actividad ${index}: ¿en qué estado o provincia? Si no aplica, escribe SALTAR.`, "text", { required: false }),
    );
  }
  return result;
}

function repeatedTravel(answers: Answers): FieldDefinition[] {
  const raw = answers["travel_history.count"]?.value;
  const count = typeof raw === "number" ? Math.min(raw, 20) : 0;
  const result: FieldDefinition[] = [];
  for (let index = 1; index <= count; index++) {
    const p = `travel_history.${index}`;
    result.push(
      field(`${p}.from`, "Viajes anteriores", `Inicio viaje ${index}`, `Viaje ${index}: ¿en qué mes y año comenzó? Usa MM/AAAA.`, "year_month", { forms: ["IMM5257-SCHEDULE-1"] }),
      field(`${p}.until`, "Viajes anteriores", `Fin viaje ${index}`, `Viaje ${index}: ¿en qué mes y año terminó? Usa MM/AAAA.`, "year_month", { forms: ["IMM5257-SCHEDULE-1"] }),
      field(`${p}.country`, "Viajes anteriores", `País viaje ${index}`, `Viaje ${index}: ¿a qué país viajaste?`, "text", { forms: ["IMM5257-SCHEDULE-1"] }),
      field(`${p}.city`, "Viajes anteriores", `Ciudad viaje ${index}`, `Viaje ${index}: ¿qué ciudad o lugar visitaste?`, "text", { forms: ["IMM5257-SCHEDULE-1"] }),
      field(`${p}.purpose`, "Viajes anteriores", `Propósito viaje ${index}`, `Viaje ${index}: ¿cuál fue el propósito?`, "text", { forms: ["IMM5257-SCHEDULE-1"] }),
    );
  }
  return result;
}

export function catalogFor(answers: Answers): FieldDefinition[] {
  const childInsert = core.findIndex((item) => item.id === "children.count") + 1;
  const withChildren = [...core.slice(0, childInsert), ...repeatedChildren(answers), ...core.slice(childInsert)];
  const adjustedEmploymentInsert = withChildren.findIndex((item) => item.id === "visit.purpose");
  const withEmployment = [...withChildren.slice(0, adjustedEmploymentInsert), ...repeatedEmployment(answers), ...withChildren.slice(adjustedEmploymentInsert)];
  const complete = [...withEmployment, ...repeatedTravel(answers)];
  return complete.filter((item) => item.applies(answers)).map((item, index) => ({
    ...item,
    prompt: addressPrompt(item.prompt, item.id, answers),
    order: index,
  }));
}

export function fieldById(id: string, answers: Answers): FieldDefinition | undefined {
  return catalogFor(answers).find((item) => item.id === id);
}
