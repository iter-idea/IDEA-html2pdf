# IDEA HTML -> PDF

IDEA helper for generating a PDF from HTML contents.
See also AWS Lambda gist: https://gist.github.com/uatisdeproblem/c4204778ed983f99bbbc18758ac1aed0

## Installation

`npm i idea-html2pdf`

## Usage example

```
import { HTML2PDF } from 'idea-html2pdf';
```

## Documentation

Documentation generated with TypeDoc: [link](https://uatisdeproblem.github.io/IDEA-html2pdf).

## Important when updating the targeted Node.js version

[Follow this guide](https://app.notion.com/p/iter-idea/IDEA-html2pdf-feature-explanation-and-AWS-Lambda-layer-creation-24245eea580780769f17c915bbea8c81?v=e6daf6610a0a44d7a99f64276578ba18&source=copy_link), since it will probably break without a specific intervention.

## Notes

The AWS SDK's (v3) packages are already pre-installed in every Lambda Function; therefore, they are `peerDependencies`.
