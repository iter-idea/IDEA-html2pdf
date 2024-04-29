import { GetObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { Upload } from '@aws-sdk/lib-storage';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { InvokeCommand, LambdaClient } from '@aws-sdk/client-lambda';
import * as Handlebars from 'handlebars';
import { Label, Languages, mdToHtml, PDFTemplateSection, SignedURL } from 'idea-toolbox';

const s3 = new S3Client();
const lambda = new LambdaClient();

/**
 * A custom class that takes advantage of the `idea_html2pdf` Lambda function to easily manage the creation of PDFs.
 */
export class HTML2PDF {
  constructor(private options: HTML2PDFInitParameters = {}) {
    if (!options.lambdaFnName) options.lambdaFnName = 'idea_html2pdf:prod';
    if (!options.lambdaFnViaS3BucketName) options.lambdaFnViaS3BucketName = 'idea_html2pdf_viaS3Bucket:prod';
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
    const defaultHelpers: any = {
      get: (context: any, x: string): any => context[x],
      getOrDash: (context: any, x: string): any => (context[x] !== null && context[x] !== undefined ? context[x] : '-'),
      getOrNewLine: (context: any, x: string): any =>
        context[x] !== null && context[x] !== undefined ? context[x].toString().trim() : '<br>',
      substituteVars: (data: any, str: string): string => {
        if (!str || !data) return str || '';
        str = String(str);
        const matches = str.match(/@\w*/gm);
        if (matches)
          matches.forEach(attr => {
            const isDefined = data[attr] !== null && data[attr] !== undefined;
            str = str.replace(attr, isDefined ? data[attr] : '');
          });
        return str;
      },
      isFieldABoolean: (data: any, value: any): boolean => typeof data[value] === 'boolean',
      isFieldANumber: (data: any, value: any): boolean => typeof data[value] === 'number',
      ifEqual: (a: any, b: any, opt: any): any => (a === b ? opt.fn(this) : opt.inverse(this)),

      mdToHTML: (s: string): Handlebars.SafeString =>
        typeof s === 'string' ? new Handlebars.SafeString(mdToHtml(s)) : s,

      label: (label: Label): any =>
        this.options.language && this.options.languages && label
          ? label[this.options.language] ?? label[this.options.languages.default]
          : null,

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
      const command = new InvokeCommand({
        FunctionName: this.options.lambdaFnName,
        InvocationType: 'RequestResponse',
        Payload: JSON.stringify(params)
      });
      const { Payload } = await lambda.send(command);
      return Buffer.from(Buffer.from(Payload).toString(), 'base64');
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
   * @return the PDF data (Buffer)
   */
  async createViaS3Bucket(params: HTML2PDFCreateViaS3BucketParameters): Promise<Buffer> {
    try {
      const invokeCommand = new InvokeCommand({
        FunctionName: this.options.lambdaFnViaS3BucketName,
        InvocationType: 'RequestResponse',
        Payload: JSON.stringify(params)
      });
      const { Payload } = await lambda.send(invokeCommand);

      const s3params = JSON.parse(Buffer.from(Payload).toString());

      const getObjCommand = new GetObjectCommand(s3params);
      const { Body } = await s3.send(getObjCommand);
      return Buffer.from(await Body.transformToString('base64'), 'base64');
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

    const Bucket = params.s3Bucket;
    const Key = params.s3Prefix.concat('/', Date.now().toString().concat(Math.random().toString(36).slice(2)), '.pdf');

    const upload = new Upload({
      client: s3,
      params: { Bucket, Key, Body: pdfData, ContentType: 'application/pdf' }
    });
    await upload.done();

    const getCommand = new GetObjectCommand({ Bucket, Key });
    const url = await getSignedUrl(s3, getCommand, { expiresIn: 120 });
    return new SignedURL({ url });
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
   * Default: `idea_html2pdf:prod`.
   */
  lambdaFnName?: string;
  /**
   * The name of the default Lambda function to invoke (alternate version via S3 Bucket).
   * Default: `idea_html2pdf_viaS3Bucket:prod`.
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

/**
 * Base64 encoded string obtained from the woff2 font file.
 * We include it directly to avoid involving the Google Font's website.
 */
export const Lato =
  'data:application/octet-stream;base64,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';

export const PDF_DEFAULT_TEMPLATE = `
  <!DOCTYPE html>
  <html>

  <head>
    <meta charset="utf8" />
    <title>
      PDF template
    </title>
    <style>
      @font-face {
        font-family: "Lato";
        src: url(${Lato});
      }
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
                              <svg height="18" width="18"><path d="M7 5c-1.103 0-2 .897-2 2v10c0 1.103.897 2 2 2h10c1.103 0 2-.897 2-2V7c0-1.103-.897-2-2-2H7zm0 12V7h10l.002 10H7z"/><path d="M10.996 12.556 9.7 11.285l-1.4 1.43 2.704 2.647 4.699-4.651-1.406-1.422z"/></svg>
                            {{else}}
                              <svg height="18" width="18"><path d="M7 5c-1.103 0-2 .897-2 2v10c0 1.103.897 2 2 2h10c1.103 0 2-.897 2-2V7c0-1.103-.897-2-2-2H7zm0 12V7h10l.002 10H7z"/></svg>
                            {{/if}}
                          {{else}}
                            {{mdToHTML (translate (getOrNewLine _data field.code))}}
                          {{/if}}
                        </td>
                      {{! complex field }}
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
