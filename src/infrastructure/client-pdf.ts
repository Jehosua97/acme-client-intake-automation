import PDFDocument from "pdfkit";
import type { Answer, FieldDefinition, Progress } from "../domain/types.js";
import type { StoredDocument } from "./sqlite-store.js";

interface CustomField {
  label: string;
  value: string;
}

export interface ClientPdfData {
  organizationName: string;
  displayName: string;
  phone: string;
  email: string | null;
  statusLabel: string;
  progress: Progress;
  answers: Record<string, Answer>;
  fields: FieldDefinition[];
  documents: StoredDocument[];
  customFields: CustomField[];
  generatedAt?: Date;
}

export interface ReportItem {
  label: string;
  value: string;
  status?: string;
  link?: string;
}

export interface ReportSection {
  title: string;
  items: ReportItem[];
}

export interface EmploymentReportRow {
  from: ReportItem;
  until: ReportItem;
  activity: ReportItem;
  organization: ReportItem;
  location: ReportItem;
  sortKey: string;
}

const INTERNAL_LABELS: Record<string, string> = {
  "contact.mailing_country": "País de dirección postal",
  "contact.residential_country": "País de residencia",
  "contact.phone_type": "Tipo de teléfono",
  "education.country": "País de estudios",
  "identity.birth_country": "País de nacimiento",
  "identity.citizenship": "Ciudadanía",
  "language.mother_tongue": "Lengua materna",
  "language.preferred": "Idioma de atención",
  "residence.applying_from_current": "Solicitud desde residencia actual",
  "residence.current_country": "País de residencia actual",
  "residence.current_status": "Estatus de residencia",
};

const ANSWER_STATUS: Record<Answer["status"], string> = {
  CONFIRMED: "Confirmado",
  PENDING: "Pendiente",
  PROPOSED: "Por confirmar",
  CONFLICT: "Revisar",
};

function answerText(answer: Answer | undefined): string {
  if (!answer || answer.value === null || answer.value === "") return answer?.status === "PENDING" ? "Pendiente" : "Sin dato";
  if (answer.value === true) return "Sí";
  if (answer.value === false) return "No";
  const value = String(answer.value);
  const date = value.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (date) return `${date[3]}/${date[2]}/${date[1]}`;
  const month = value.match(/^(\d{4})-(\d{2})$/);
  if (month) return `${month[2]}/${month[1]}`;
  return value === "CURRENT" ? "ACTUAL" : value;
}

function answerItem(label: string, answer: Answer | undefined): ReportItem {
  const value = answerText(answer);
  const status = answer ? ANSWER_STATUS[answer.status] : undefined;
  return {
    label,
    value,
    ...(status && status !== "Confirmado" && status !== value ? { status } : {}),
  };
}

function combinedLocation(city: Answer | undefined, province: Answer | undefined): ReportItem {
  const answers = [city, province];
  const values = answers.map(answerText);
  const meaningful = values.filter((value) => value !== "Sin dato" && value !== "Pendiente");
  const value = meaningful.length
    ? [...new Set(meaningful)].join(", ")
    : values.includes("Pendiente") ? "Pendiente" : "Sin dato";
  const status = answers.some((answer) => answer?.status === "CONFLICT")
    ? "Revisar"
    : answers.some((answer) => answer?.status === "PROPOSED") ? "Por confirmar" : undefined;
  return { label: "Ciudad y estado", value, ...(status && status !== value ? { status } : {}) };
}

export function employmentRowsForPdf(data: Pick<ClientPdfData, "answers" | "fields">): EmploymentReportRow[] {
  const indexes = new Set<number>();
  for (const field of data.fields) {
    const match = field.id.match(/^employment\.(\d+)\./);
    if (match) indexes.add(Number(match[1]));
  }
  for (const fieldId of Object.keys(data.answers)) {
    const match = fieldId.match(/^employment\.(\d+)\./);
    if (match) indexes.add(Number(match[1]));
  }

  return [...indexes].map((index) => {
    const prefix = `employment.${index}`;
    const from = data.answers[`${prefix}.from`];
    return {
      from: answerItem("Inicio", from),
      until: answerItem("Fin", data.answers[`${prefix}.until`]),
      activity: answerItem("Actividad u ocupación", data.answers[`${prefix}.activity`]),
      organization: answerItem("Empresa, institución o situación", data.answers[`${prefix}.organization`]),
      location: combinedLocation(data.answers[`${prefix}.city`], data.answers[`${prefix}.province`]),
      sortKey: typeof from?.value === "string" && /^\d{4}-\d{2}$/.test(from.value) ? from.value : "9999-99",
    };
  }).sort((left, right) => left.sortKey.localeCompare(right.sortKey));
}

export function reportSectionTitleForField(field: FieldDefinition): string {
  if (field.section !== "Familia") return field.section;
  if (field.id.startsWith("partner.")) return "Familia · Pareja actual";
  if (field.id.startsWith("previous_partner.")) return "Familia · Pareja anterior";
  if (field.id.startsWith("mother.")) return "Familia · Madre";
  if (field.id.startsWith("father.")) return "Familia · Padre";
  const child = field.id.match(/^children\.(\d+)\./);
  if (child) return `Familia · Hijo/a ${child[1]}`;
  return "Familia · Resumen familiar";
}

export function reportSectionsForPdf(data: ClientPdfData): ReportSection[] {
  const grouped = new Map<string, ReportItem[]>();
  const visibleIds = new Set<string>();
  for (const field of data.fields) {
    if (field.forms.includes("INTERNAL")) continue;
    visibleIds.add(field.id);
    if (field.section === "Empleo") continue;
    const answer = data.answers[field.id];
    const sectionTitle = reportSectionTitleForField(field);
    const items = grouped.get(sectionTitle) ?? [];
    items.push(answerItem(field.label, answer));
    grouped.set(sectionTitle, items);
  }

  const systemItems: ReportItem[] = [];
  for (const [fieldId, answer] of Object.entries(data.answers)) {
    if (visibleIds.has(fieldId) || fieldId === "workflow.passport_uploaded") continue;
    const label = INTERNAL_LABELS[fieldId] ?? null;
    if (!label || answer.value === null || answer.value === "") continue;
    systemItems.push({ label, value: answerText(answer), status: ANSWER_STATUS[answer.status] });
  }

  const sections: ReportSection[] = [...grouped].map(([title, items]) => ({ title, items }));
  if (systemItems.length) sections.push({ title: "Datos definidos por el sistema", items: systemItems });
  if (data.customFields.length) sections.push({
    title: "Datos adicionales",
    items: data.customFields.map((item) => ({ label: item.label, value: item.value })),
  });
  sections.push({
    title: "Documentos recibidos",
    items: data.documents.length
      ? data.documents.map((document, index) => ({
          label: index === 0 ? "Pasaporte en Google Drive" : `Documento ${index + 1} en Google Drive`,
          value: `${document.name} · ${(document.size / 1024 / 1024).toFixed(2)} MB · Abrir archivo`,
          link: document.webViewLink,
        }))
      : [{ label: "Documentos", value: "Sin documentos guardados" }],
  });
  return sections;
}

export function clientPdfFilename(name: string): string {
  const safeName = name
    .normalize("NFC")
    .replace(/[\\/:*?"<>|\u0000-\u001f]/g, " ")
    .replace(/\s+/g, " ")
    .replace(/[. ]+$/g, "")
    .trim()
    .slice(0, 120) || "Cliente";
  return `${safeName}_expediente.pdf`;
}

export async function generateClientPdf(data: ClientPdfData): Promise<Buffer> {
  const doc = new PDFDocument({ size: "A4", layout: "landscape", margins: { top: 28, right: 28, bottom: 30, left: 28 }, bufferPages: true });
  const chunks: Buffer[] = [];
  doc.on("data", (chunk: Buffer) => chunks.push(chunk));
  const completed = new Promise<Buffer>((resolve, reject) => {
    doc.on("end", () => resolve(Buffer.concat(chunks)));
    doc.on("error", reject);
  });

  const generatedAt = data.generatedAt ?? new Date();
  const pageBottom = () => doc.page.height - doc.page.margins.bottom - 14;
  const contentWidth = doc.page.width - doc.page.margins.left - doc.page.margins.right;
  const addPage = () => { doc.addPage({ size: "A4", layout: "landscape", margins: { top: 28, right: 28, bottom: 30, left: 28 } }); };
  const ensureSpace = (height: number) => { if (doc.y + height > pageBottom()) addPage(); };

  doc.fillColor("#1f6b4f").font("Helvetica-Bold").fontSize(8).text(data.organizationName.toUpperCase(), { characterSpacing: 1.2 });
  doc.fillColor("#18231f").font("Helvetica-Bold").fontSize(20).text("Expediente de visa", { continued: false });
  doc.moveDown(0.15);
  doc.font("Helvetica-Bold").fontSize(13).text(data.displayName || "Cliente sin nombre");
  doc.font("Helvetica").fontSize(8).fillColor("#5f6d67").text(
    [data.phone, data.email, `Estado: ${data.statusLabel}`, `Avance interno: ${data.progress.percent}%`].filter(Boolean).join("   |   "),
  );
  doc.moveDown(0.5);
  doc.moveTo(doc.page.margins.left, doc.y).lineTo(doc.page.width - doc.page.margins.right, doc.y).strokeColor("#d9e2de").stroke();
  doc.moveDown(0.65);

  const columns = 3;
  const gap = 10;
  const columnWidth = (contentWidth - gap * (columns - 1)) / columns;
  const gridRowHeight = (row: ReportItem[]) => Math.max(...row.map((item) => {
    doc.font("Helvetica-Bold").fontSize(6.5);
    const labelHeight = doc.heightOfString(item.label, { width: columnWidth - 12 });
    doc.font("Helvetica").fontSize(8);
    const valueHeight = doc.heightOfString(item.value, { width: columnWidth - 12 });
    return Math.max(29, labelHeight + valueHeight + 12);
  }));
  const drawGridSection = (section: ReportSection) => {
    const rows: ReportItem[][] = [];
    for (let index = 0; index < section.items.length; index += columns) rows.push(section.items.slice(index, index + columns));
    const estimatedHeight = 28 + rows.reduce((total, row) => total + gridRowHeight(row), 0);
    const usablePageHeight = pageBottom() - doc.page.margins.top;
    if (section.title.startsWith("Familia ·") && estimatedHeight <= usablePageHeight && doc.y + estimatedHeight > pageBottom()) addPage();
    else ensureSpace(32);
    const headerY = doc.y;
    doc.roundedRect(doc.page.margins.left, headerY, contentWidth, 18, 4).fill("#eaf3ee");
    doc.fillColor("#1f6b4f").font("Helvetica-Bold").fontSize(9).text(section.title, doc.page.margins.left + 8, headerY + 5, { width: contentWidth - 16, lineBreak: false });
    doc.y = headerY + 24;

    for (let index = 0; index < section.items.length; index += columns) {
      const row = section.items.slice(index, index + columns);
      const rowHeight = gridRowHeight(row);
      if (doc.y + rowHeight > pageBottom()) {
        addPage();
        doc.fillColor("#1f6b4f").font("Helvetica-Bold").fontSize(8).text(`${section.title} (continuación)`);
        doc.moveDown(0.35);
      }
      const rowY = doc.y;
      for (const [column, item] of row.entries()) {
        const x = doc.page.margins.left + column * (columnWidth + gap);
        doc.roundedRect(x, rowY, columnWidth, rowHeight - 3, 3).strokeColor("#e1e7e4").stroke();
        doc.font("Helvetica-Bold").fontSize(6.5);
        const labelHeight = doc.heightOfString(item.label.toUpperCase(), { width: columnWidth - 12 });
        doc.fillColor("#68746f").text(item.label.toUpperCase(), x + 6, rowY + 5, { width: columnWidth - 12 });
        const valueY = rowY + 7 + labelHeight;
        const isMissing = item.value === "Sin dato" || item.value === "Pendiente";
        doc.fillColor(isMissing ? "#9a6a22" : item.link ? "#1f6b4f" : "#18231f").font("Helvetica").fontSize(8).text(
          item.value,
          x + 6,
          valueY,
          { width: columnWidth - 12, ...(item.link ? { link: item.link, underline: true } : {}) },
        );
        if (item.status && item.status !== "Confirmado" && item.status !== item.value) {
          doc.fillColor("#9a6a22").font("Helvetica-Oblique").fontSize(6).text(item.status, x + 6, rowY + rowHeight - 10, { width: columnWidth - 12 });
        }
      }
      doc.y = rowY + rowHeight;
    }
    doc.moveDown(0.35);
  };

  const employmentRows = employmentRowsForPdf(data);
  const employmentHeaders = ["FECHA DE INICIO", "FECHA FINAL", "ACTIVIDAD U OCUPACIÓN", "EMPRESA, INSTITUCIÓN O SITUACIÓN", "CIUDAD Y ESTADO · MÉXICO"];
  const employmentRatios = [0.11, 0.11, 0.24, 0.29, 0.25];
  const employmentWidths = employmentRatios.map((ratio) => contentWidth * ratio);
  const drawEmploymentHeading = (continuation = false) => {
    const titleY = doc.y;
    doc.roundedRect(doc.page.margins.left, titleY, contentWidth, 18, 4).fill("#eaf3ee");
    doc.fillColor("#1f6b4f").font("Helvetica-Bold").fontSize(9).text(
      `Actividades de los últimos 10 años · orden cronológico${continuation ? " (continuación)" : ""}`,
      doc.page.margins.left + 8,
      titleY + 5,
      { width: contentWidth - 16, lineBreak: false },
    );
    const tableHeaderY = titleY + 24;
    let x = doc.page.margins.left;
    for (const [index, label] of employmentHeaders.entries()) {
      const width = employmentWidths[index]!;
      doc.rect(x, tableHeaderY, width, 17).fillAndStroke("#f4f7f5", "#dce4e0");
      doc.fillColor("#68746f").font("Helvetica-Bold").fontSize(6.2).text(label, x + 5, tableHeaderY + 5, { width: width - 10, lineBreak: false });
      x += width;
    }
    doc.y = tableHeaderY + 17;
  };
  const drawEmploymentSection = () => {
    ensureSpace(70);
    drawEmploymentHeading();
    for (const row of employmentRows) {
      const cells = [row.from, row.until, row.activity, row.organization, row.location];
      const rowHeight = Math.max(25, ...cells.map((cell, index) => {
        doc.font("Helvetica").fontSize(7.5);
        const textHeight = doc.heightOfString(cell.value, { width: employmentWidths[index]! - 10 });
        return textHeight + (cell.status ? 7 : 0) + 10;
      }));
      if (doc.y + rowHeight > pageBottom()) {
        addPage();
        drawEmploymentHeading(true);
      }
      const rowY = doc.y;
      let x = doc.page.margins.left;
      for (const [index, cell] of cells.entries()) {
        const width = employmentWidths[index]!;
        doc.rect(x, rowY, width, rowHeight).strokeColor("#dce4e0").stroke();
        const isMissing = cell.value === "Sin dato" || cell.value === "Pendiente";
        doc.fillColor(isMissing ? "#9a6a22" : "#18231f").font("Helvetica").fontSize(7.5).text(cell.value, x + 5, rowY + 6, { width: width - 10 });
        if (cell.status && cell.status !== cell.value) {
          doc.fillColor("#9a6a22").font("Helvetica-Oblique").fontSize(5.8).text(cell.status, x + 5, rowY + rowHeight - 9, { width: width - 10, lineBreak: false });
        }
        x += width;
      }
      doc.y = rowY + rowHeight;
    }
    doc.moveDown(0.35);
  };

  let employmentRendered = false;
  for (const section of reportSectionsForPdf(data)) {
    if (employmentRows.length && !employmentRendered && section.title === "Viaje") {
      drawEmploymentSection();
      employmentRendered = true;
    }
    drawGridSection(section);
  }
  if (employmentRows.length && !employmentRendered) drawEmploymentSection();

  const pages = doc.bufferedPageRange();
  for (let index = pages.start; index < pages.start + pages.count; index++) {
    doc.switchToPage(index);
    doc.fillColor("#75817c").font("Helvetica").fontSize(6.5).text(
      `Generado ${generatedAt.toLocaleString("es-MX")}   |   Página ${index + 1} de ${pages.count}`,
      doc.page.margins.left,
      doc.page.height - doc.page.margins.bottom - 9,
      { width: contentWidth, align: "right", lineBreak: false },
    );
  }

  doc.end();
  return completed;
}
