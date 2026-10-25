import { Router, Request, Response, NextFunction } from 'express';
import swaggerUi from 'swagger-ui-express';
import redoc from 'redoc-express';
import Ajv from 'ajv';
import addFormats from 'ajv-formats';
import { openapiSpecification } from '../docs/openapiSpec';

const router = Router();

// Initialize AJV for development schema validation
const ajv = new Ajv({ allErrors: true, coerceTypes: true });
addFormats(ajv);

// Compile AJV Validators
const deployValidator = ajv.compile(
  openapiSpecification.components!.schemas!.DeployContractRequest
);

/**
 * AJV Request Validation Middleware for Development Mode
 */
export const validateOpenApiSchema = (schemaKey: string) => {
  return (req: Request, res: Response, next: NextFunction) => {
    if (process.env.NODE_ENV === 'development') {
      const isValid = deployValidator(req.body);
      if (!isValid) {
        return res.status(400).json({
          error: 'OpenAPI Schema Validation Failed',
          details: deployValidator.errors,
        });
      }
    }
    next();
  };
};

// 1. Raw OpenAPI Specification JSON Endpoint
router.get('/openapi.json', (req: Request, res: Response) => {
  res.setHeader('Content-Type', 'application/json');
  res.status(200).send(openapiSpecification);
});

// 2. Interactive Swagger UI Interface with Custom Brand Theme
const swaggerOptions: swaggerUi.SwaggerOptions = {
  customCss: `
    .swagger-ui { background-color: #0b0f19; color: #e2e8f0; }
    .swagger-ui .topbar { display: none; }
    .swagger-ui .info { margin: 20px 0; }
    .swagger-ui .info .title { color: #38bdf8; }
    .swagger-ui .scheme-container { background-color: #1e293b; box-shadow: none; }
    .swagger-ui .opblock { border-radius: 8px; }
  `,
  customSiteTitle: 'Soroban Playground - Interactive API Docs',
};

router.use(
  '/swagger',
  swaggerUi.serve,
  swaggerUi.setup(openapiSpecification, swaggerOptions)
);

// 3. Interactive Redoc Documentation Interface
router.get(
  '/redoc',
  redoc({
    title: 'Soroban Playground API Docs',
    specUrl: '/v1/docs/openapi.json',
    nonce: '',
    redocOptions: {
      theme: {
        colors: {
          primary: {
            main: '#38bdf8',
          },
        },
        typography: {
          fontFamily: 'Inter, sans-serif',
        },
      },
    },
  })
);

export default router;
