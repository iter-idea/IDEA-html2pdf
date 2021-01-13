import { Lambda } from 'aws-sdk';
import { compile, SafeString, HelperDelegate, registerHelper } from 'handlebars';
import { S3 } from 'idea-aws';
import { Label, Languages, logger, mdToHtml, PDFTemplateSection, SignedURL } from 'idea-toolbox';

/**
 * A custom class that takes advantage of the `idea_html2pdf` Lambda function to easily manage the creation of PDFs.
 */
export class HTML2PDF {
  /**
   * The instance of Lambda.
   */
  protected lambda: Lambda;
  /**
   * The instance of S3.
   */
  protected s3: S3;
  /**
   * The name of the default Lambda function to invoke.
   */
  protected LAMBDA_NAME = 'idea_html2pdf:prod';

  constructor() {
    this.lambda = new Lambda();
    this.s3 = new S3();
  }

  /**
   * Compile an Handlebars template.
   */
  public handlebarsCompile(input: any, options?: CompileOptions): HandlebarsTemplateDelegate {
    return compile(input, options);
  }
  /**
   * Return a new safe string for Handlebars templates.
   */
  public handlebarsSafeString(str: string): SafeString {
    return new SafeString(str);
  }
  /**
   * Register an additional handelbars helper.
   */
  public handlebarsRegisterHelper(name: string, func: HelperDelegate | any) {
    registerHelper(name, func);
  }

  /**
   * Create a new PDF created by an HTML source.
   * @param params the parameters to create the PDF
   * @param alternativeLambda an alternative lambda function to use to generate the PDF
   * @return the PDF data (buffer)
   */
  public create(params: HTML2PDFParameters, alternativeLambda?: string): Promise<Buffer> {
    return new Promise((resolve, reject) => {
      this.lambda.invoke(
        {
          FunctionName: alternativeLambda || this.LAMBDA_NAME,
          InvocationType: 'RequestResponse',
          Payload: JSON.stringify(params)
        },
        (err: Error, data: any) => {
          if (err) {
            logger('PDF creation failed', err, alternativeLambda || this.LAMBDA_NAME);
            reject(err);
          } else resolve(Buffer.from(data.Payload, 'base64'));
        }
      );
    });
  }

  /**
   * Create the signedURL to a new PDF created by an HTML source.
   * @param params the parameters to create the PDF
   * @param alternativeLambda an alternative lambda function to use to generate the PDF
   * @param downloadOptions the parameters create the download link
   * @return the URL to download the PDF
   */
  public createLink(params: HTML2PDFParameters, alternativeLambda?: string, downloadOptions?: any): Promise<SignedURL> {
    return new Promise((resolve, reject) => {
      this.create(params, alternativeLambda)
        .then(pdfData => resolve(this.s3.createDownloadURLFromData(pdfData, downloadOptions)))
        .catch(err => reject(err));
    });
  }

  /**
   * Helper function to prepare Handlebar's helper for the `PDFTemplateSection` standard.
   */
  public getHandlebarHelpersForPDFTemplate(
    language: string,
    languages: Languages,
    htmlInnerTemplate: string,
    additionalTranslations?: { [term: string]: string }
  ): any {
    return {
      get: (context: any, x: string) => context[x],
      getOrDash: (context: any, x: string) => (context[x] !== null && context[x] !== undefined ? context[x] : '-'),
      doesColumnContainAField: (section: PDFTemplateSection, colIndex: number) =>
        section.doesColumnContainAField(colIndex),
      getColumnFieldSize: (section: PDFTemplateSection, colIndex: number) => section.getColumnFieldSize(colIndex),
      substituteVars: (data: any, str: string) => {
        if (!str || !data) return str || '';
        str = String(str);
        const matches = str.match(/@\w*/gm);
        if (matches)
          matches.forEach(attr => {
            if (data[attr] !== undefined) str = str.replace(attr, data[attr] === null ? '' : data[attr]);
          });
        return str;
      },
      inception: (_template: any, _data: any) => {
        const variables = { _template, _data };
        return new SafeString(compile(htmlInnerTemplate, { compat: true })(variables));
      },
      isFieldABoolean: (data: any, value: any) => typeof data[value] === 'boolean',
      isFieldANumber: (data: any, value: any) => typeof data[value] === 'number',
      ifEqual: (a: any, b: any, opt: any) => (a === b ? opt.fn(this) : opt.inverse(this)),
      label: (label: Label) => (label ? label[language] || label[languages.default] : null),
      mdToHTML: (s: string) => (typeof s === 'string' ? new SafeString(mdToHtml(s)) : s),
      translate: (s: string) =>
        s && additionalTranslations && additionalTranslations[s] ? additionalTranslations[s] : s
    };
  }
}

export interface HTML2PDFParameters {
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

export const PDF_TEMPLATE = `
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
