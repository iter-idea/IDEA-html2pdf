import { S3, Lambda } from 'aws-sdk';
import * as Handlebars from 'handlebars';
import { Label, Languages, mdToHtml, PDFTemplateSection, SignedURL } from 'idea-toolbox';

const s3 = new S3({ apiVersion: '2006-03-01', signatureVersion: 'v4' });
const lambda = new Lambda();

/**
 * A custom class that takes advantage of the `idea_html2pdf` Lambda function to easily manage the creation of PDFs.
 */
export class HTML2PDF {
  constructor(private options: HTML2PDFInitParameters = {}) {
    if (!options.lambdaFnName) options.lambdaFnName = 'idea_html2pdf';
    if (!options.lambdaFnViaS3BucketName) options.lambdaFnViaS3BucketName = 'idea_html2pdf_viaS3Bucket';
    this.handlebarsRegisterDefaultHelpers();
  }

  /**
   * Compile an Handlebars template.
   */
  handlebarsCompile(input: any, options?: CompileOptions): HandlebarsTemplateDelegate {
    return Handlebars.compile(input, options);
  }
  /**
   * Return a new safe string for Handlebars templates.
   */
  handlebarsSafeString(str: string): Handlebars.SafeString {
    return new Handlebars.SafeString(str);
  }
  /**
   * Register an additional handelbars helper.
   */
  handlebarsRegisterHelper(name: string, func: Handlebars.HelperDelegate | any): void {
    Handlebars.registerHelper(name, func);
  }
  /**
   * Register some commonly-used handlebars helpers.
   */
  private handlebarsRegisterDefaultHelpers(): void {
    const lang = this.options.language ?? this.options.languages.default;

    const defaultHelpers: any = {
      get: (context: any, x: string): any => context[x],
      getOrDash: (context: any, x: string): any => (context[x] !== null && context[x] !== undefined ? context[x] : '-'),
      substituteVars: (data: any, str: string): string => {
        if (!str || !data) return str || '';
        str = String(str);
        const matches = str.match(/@\w*/gm);
        if (matches)
          matches.forEach(attr => {
            if (data[attr] !== undefined) str = str.replace(attr, data[attr] === null ? '' : data[attr]);
          });
        return str;
      },
      isFieldABoolean: (data: any, value: any): boolean => typeof data[value] === 'boolean',
      isFieldANumber: (data: any, value: any): boolean => typeof data[value] === 'number',
      ifEqual: (a: any, b: any, opt: any): any => (a === b ? opt.fn(this) : opt.inverse(this)),

      mdToHTML: (s: string): Handlebars.SafeString =>
        typeof s === 'string' ? new Handlebars.SafeString(mdToHtml(s)) : s,

      label: (label: Label): any =>
        this.options.languages && label ? label[lang] ?? label[this.options.languages.default] : null,

      translate: (s: string): string =>
        this.options.additionalTranslations && s && this.options.additionalTranslations[s]
          ? this.options.additionalTranslations[s]
          : s
    };
    for (const h in defaultHelpers) if (defaultHelpers[h]) this.handlebarsRegisterHelper(h, defaultHelpers[h]);
  }
  /**
   * Register handlebars helpers for the `PDFTemplateSection` IDEA standard.
   */
  handlebarsRegisterHelpersForPDFTemplate(htmlInnerTemplate: string): any {
    const helpers: any = {
      doesColumnContainAField: (section: PDFTemplateSection, colIndex: number): boolean =>
        section.doesColumnContainAField(colIndex),
      getColumnFieldSize: (section: PDFTemplateSection, colIndex: number): number =>
        section.getColumnFieldSize(colIndex),
      inception: (_template: any, _data: any): Handlebars.SafeString => {
        const variables = { _template, _data };
        return new Handlebars.SafeString(Handlebars.compile(htmlInnerTemplate, { compat: true })(variables));
      }
    };

    for (const h in helpers) if (helpers[h]) this.handlebarsRegisterHelper(h, helpers[h]);
  }

  /**
   * Create a new PDF created by an HTML source.
   * @param params the parameters to create the PDF
   * @return the PDF data (buffer)
   */
  async create(params: HTML2PDFCreateParameters): Promise<Buffer> {
    try {
      const result = await lambda
        .invoke({
          FunctionName: this.options.lambdaFnName,
          InvocationType: 'RequestResponse',
          Payload: JSON.stringify(params)
        })
        .promise();
      return Buffer.from((result as any).Payload, 'base64');
    } catch (err) {
      console.error('PDF creation failed', err, this.options.lambdaFnName);
      throw err;
    }
  }
  /**
   * Create a new PDF created by an HTML source.
   * TO USE ONLY when the expected PDF payload is very large (it's slower than the altenative).
   * It takes advantage of an intermediate S3 bucket to avoid Lambda's payload limits.
   * @param params the parameters to create the PDF
   * @return the PDF data (buffer)
   */
  async createViaS3Bucket(params: HTML2PDFCreateViaS3BucketParameters): Promise<Buffer> {
    try {
      const result = await lambda
        .invoke({
          FunctionName: this.options.lambdaFnViaS3BucketName,
          InvocationType: 'RequestResponse',
          Payload: JSON.stringify(params)
        })
        .promise();

      const s3params = JSON.parse((result as any).Payload);
      const s3Obj = await s3.getObject(s3params).promise();

      return s3Obj.Body as Buffer;
    } catch (err) {
      console.error('PDF creation failed', err, this.options.lambdaFnViaS3BucketName);
      throw err;
    }
  }

  /**
   * Create the signedURL to a new PDF created by an HTML source.
   * @param params the parameters to create the PDF
   * @return the URL to download the PDF
   */
  async createLink(params: HTML2PDFCreateViaS3BucketParameters): Promise<SignedURL> {
    const pdfData = await this.create(params);

    const Key = params.s3Prefix.concat(
      '/',
      new Date().getTime().toString().concat(Math.random().toString(36).slice(2)),
      '.pdf'
    );
    const Bucket = params.s3Bucket;
    const Expires = 120;

    await s3.upload({ Bucket, Key, Body: pdfData }).promise();
    return new SignedURL({ url: s3.getSignedUrl('getObject', { Bucket, Key, Expires }) });
  }
}

export interface HTML2PDFInitParameters {
  /**
   * The language configuration to use to enable translations helpers.
   */
  languages?: Languages;
  /**
   * The preferred language for translations helpers.
   */
  language?: string;
  /**
   * Additional dictionary to use in translations helpers.
   */
  additionalTranslations?: { [term: string]: string };
  /**
   * The name of the default Lambda function to invoke.
   * Default: `idea_html2pdf`.
   */
  lambdaFnName?: string;
  /**
   * The name of the default Lambda function to invoke (alternate version via S3 Bucket).
   * Default: `idea_html2pdf_viaS3Bucket`.
   */
  lambdaFnViaS3BucketName?: string;
}

export interface HTML2PDFCreateParameters {
  /**
   * The html main body.
   */
  body: string;
  /**
   * An optional html header, repeated in every page.
   */
  header?: string;
  /**
   * An optional html footer, repeated in every page.
   */
  footer?: string;
  /**
   * Options following the standard of Puppeteer.
   */
  pdfOptions: any;
}
export interface HTML2PDFCreateViaS3BucketParameters extends HTML2PDFCreateParameters {
  /**
   * The S3 bucket where to put the generated PDF file.
   */
  s3Bucket: string;
  /**
   * The prefix for the generated PDF file in the S3 bucket.
   */
  s3Prefix: string;
}

export const PDF_DEFAULT_TEMPLATE = `
  <!DOCTYPE html>
  <html>

  <head>
    <meta charset="utf8" />
    <title>
      PDF template
    </title>
    <link href="https://fonts.googleapis.com/css?family=Lato" rel="stylesheet">
    <style>
      html,
      body {
        margin: 0;
        padding: 0;
        font-size: 10pt;
        font-family: 'Lato', Arial, Helvetica, sans-serif;
      }

      table {
        width: 100%;
        table-layout: fixed;
        font-size: 1rem;
      }

      table,
      tr,
      td {
        margin: 0;
        padding: 0;
        border-spacing: 0;
        border-collapse: collapse;
        vertical-align: middle;
      }

      .dontBreak {
        page-break-inside: avoid !important;
      }
      .pageBreak {
        page-break-after: always;
      }

      table.border td {
        border: 1px solid #eee;
      }

      td > p {
        margin: 0;
        padding: 0;
      }

      .normalRow td {
        padding: 6px 8px;
        letter-spacing: -0.2px;
      }

      td .label {
        display: block;
        font-size: 0.8rem;
        font-weight: bold;
        color: #555;
      }

      .headerTable {
        margin-top: 20px;
        page-break-inside: avoid;
      }
      .headerTable::after {
        /* trick to avoid a page break right after the header */
        content: "-";
        color: white;
        display: block;
        height: 150px;
        margin-bottom: -150px;
      }
      .headerTitle {
        padding: 4px 8px;
        background-color: #444;
        border: 1px solid transparent;
        border-radius: 5px;
        font-size: 0.9rem;
        font-weight: 500;
        color: white;
      }

      .numericField {
        text-align: right;
      }
      .checkbox {
        width: 12px;
        padding-top: 2px;
      }
    </style>
  </head>

  <body>

    <!-- PDF TEMPLATE BEGIN -->

    <div class="pdfTemplate">
      {{#each _template as |section|}}
        {{! page break }}
        {{#ifEqual section.type 0}}
          <div class="pageBreak"></div>
        {{/ifEqual}}
        {{! empty row }}
        {{#ifEqual section.type 1}}
          <br />
        {{/ifEqual}}
        {{! row }}
        {{#ifEqual section.type 2}}
          <table class="normalRow dontBreak {{#if row.border}}border{{/if}}">
            <tr>
              {{#each section.columns as |content|}}
                {{#if content}}
                  {{#if (doesColumnContainAField section @index)}}{{! field (that may be repeated for more cols) }}
                    {{#with content as |field|}}
                      {{! simple field }}
                      {{#if field.code}}
                        <td
                          colspan="{{getColumnFieldSize section @index}}"
                          class="{{#if (isFieldANumber _data field.code)}}numericField{{/if}}"
                        >
                          <span class="label">
                            {{translate (label field.label)}}&nbsp;
                          </span>
                          {{#if (isFieldABoolean _data field.code)}}
                            {{#if (get _data field.code)}}
                              <img
                                class="checkbox"
                                src="https://s3.eu-west-2.amazonaws.com/scarlett-app/assets/icons/check-true.png"
                              />
                            {{else}}
                              <img
                                class="checkbox"
                                src="https://s3.eu-west-2.amazonaws.com/scarlett-app/assets/icons/check-false.png"
                              />
                            {{/if}}
                          {{else}}
                            {{mdToHTML (translate (getOrDash _data field.code))}}
                          {{/if}}
                        </td>
                      {{! complext field }}
                      {{else}}
                        <td colspan="{{getColumnFieldSize section @index}}">
                          {{#ifEqual 12 (getColumnFieldSize section @index)}}
                            {{! no extra spacing }}
                          {{else}}
                            <span class="label">&nbsp;</span>
                          {{/ifEqual}}
                          {{mdToHTML (substituteVars _data (translate (label field.content)))}}
                        </td>
                      {{/if}}
                    {{/with}}
                  {{/if}}
                {{else}}
                {{! empty col }}
                  <td colspan="1"></td>
                {{/if}}
              {{/each}}
            </tr>
          </table>
        {{/ifEqual}}
        {{! header }}
        {{#ifEqual section.type 3}}
          <table class="headerTable">
            <tr>
              <td class="headerTitle">
                {{mdToHTML (substituteVars _data (translate (label section.title)))}}
              </td>
            </tr>
          </table>
        {{/ifEqual}}
        {{! inner section }}
        {{#ifEqual section.type 4}}
          {{#if (get _data section.context)}}
            {{#if (label section.title)}}
              <table class="headerTable">
                <tr>
                  <td class="headerTitle">
                    {{translate (label section.title)}}
                  </td>
                </tr>
              </table>
            {{/if}}
            {{inception section.innerTemplate (get _data section.context)}}
          {{/if}}
        {{/ifEqual}}
        {{! repeated inner section }}
        {{#ifEqual section.type 5}}
          {{#with (get _data section.context) as |innerSections|}}
            {{#if innerSections.length}}
              {{#if (label section.title)}}
                <table class="headerTable">
                  <tr>
                    <td class="headerTitle">
                      {{translate (label section.title)}}
                    </td>
                  </tr>
                </table>
              {{/if}}
            {{/if}}
            {{#each innerSections as |innerSection|}}
              {{inception section.innerTemplate innerSection}}
            {{/each}}
          {{/with}}
        {{/ifEqual}}
      {{/each}}
    </div>

  </body>

  </html>
`;
