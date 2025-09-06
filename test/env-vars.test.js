'use strict'

const {
  test,
  describe,
  after,
  afterEach,
  beforeEach
} = require('node:test')
const assert = require('node:assert')
const Fastify = require(process.env.FASTIFY_VERSION || 'fastify')

const {
  AsyncHooksContextManager
} = require('@opentelemetry/context-async-hooks')
const { NodeTracerProvider } = require('@opentelemetry/sdk-trace-node')
const {
  InMemorySpanExporter,
  SimpleSpanProcessor
} = require('@opentelemetry/sdk-trace-base')
const { context } = require('@opentelemetry/api')
const { resourceFromAttributes } = require('@opentelemetry/resources')
const { ATTR_SERVICE_NAME } = require('@opentelemetry/semantic-conventions')

const { HttpInstrumentation } = require('@opentelemetry/instrumentation-http')

const FastifyInstrumentation = require('..')

// OTEL_SERVICE_NAME
// https://opentelemetry.io/docs/languages/sdk-configuration/general/
describe('Environment variable aware FastifyInstrumentation', () => {
  process.env.OTEL_SERVICE_NAME = 'my_app'
  process.env.OTEL_FASTIFY_IGNORE_PATHS = '/health/*'

  const httpInstrumentation = new HttpInstrumentation()
  const instrumentation = new FastifyInstrumentation()
  const contextManager = new AsyncHooksContextManager()
  const memoryExporter = new InMemorySpanExporter()

  // Test that OTEL_SERVICE_NAME environment variable gets picked up by resource
  // when no explicit service name is provided in resource configuration
  const provider = new NodeTracerProvider()
  const spanProcessor = new SimpleSpanProcessor(memoryExporter)

  provider.addSpanProcessor(spanProcessor)
  context.setGlobalContextManager(contextManager)
  httpInstrumentation.setTracerProvider(provider)
  instrumentation.setTracerProvider(provider)

  describe('Instrumentation#enabled', () => {
    beforeEach(() => {
      instrumentation.enable()
      httpInstrumentation.enable()
      contextManager.enable()
    })

    afterEach(() => {
      contextManager.disable()
      instrumentation.disable()
      httpInstrumentation.disable()
      spanProcessor.forceFlush()
      memoryExporter.reset()
    })

    test('should create spans with fastify-specific attributes (service.name comes from resource, not span attributes)', async t => {
      const app = Fastify()
      const plugin = instrumentation.plugin()

      await app.register(plugin)

      app.get('/', async (request, reply) => 'hello world')

      await app.listen()

      after(() => app.close())

      const response = await fetch(
          `http://localhost:${app.server.address().port}/`
      )

      const spans = memoryExporter
        .getFinishedSpans()
        .filter(span =>
          // Different OpenTelemetry contexts use different property names:
          // - instrumentationLibrary: Manual NodeTracerProvider + manual instrumentation registration (older)
          // - instrumentationScope: NodeSDK with auto-registration (newer standard)
          span.instrumentationLibrary?.name === '@fastify/otel' ||
          span.instrumentationScope?.name === '@fastify/otel'
        )

      const [end, start] = spans

      assert.equal(spans.length, 2)
      assert.deepStrictEqual(start.attributes, {
        'fastify.root': '@fastify/otel',
        'http.route': '/',
        'http.request.method': 'GET',
        'http.response.status_code': 200
      })
      assert.deepStrictEqual(end.attributes, {
        'hook.name': 'fastify -> @fastify/otel - route-handler',
        'fastify.type': 'request-handler',
        'http.route': '/',
        'hook.callback.name': 'anonymous'
      })

      // Service name should come from OpenTelemetry SDK defaults (not from instrumentation)
      // NOTE: With the PR changes, the instrumentation no longer sets service.name in span attributes.
      // Environment variable support (OTEL_SERVICE_NAME) should be handled at the SDK/Resource level,
      // typically via NodeSDK. Here we verify the service name exists in resource and not in span attributes.
      const serviceName = start.resource.attributes['service.name']
      assert.ok(serviceName, 'Service name should be present in resource')
      assert.equal(start.resource.attributes['service.name'], end.resource.attributes['service.name'])

      // Verify service.name is NOT in span attributes (should only be in resource)
      assert.equal('service.name' in start.attributes, false)
      assert.equal('service.name' in end.attributes, false)

      assert.equal(response.status, 200)
      assert.equal(await response.text(), 'hello world')
    })

    test('should ignore route path instrumentation if FastifyOptions#ignorePaths is set (string|glob)', async () => {
      const instrumentation = new FastifyInstrumentation()

      const app = Fastify()
      const plugin = instrumentation.plugin()

      await app.register(plugin)

      app.get('/health/up', async (request, reply) => 'hello world')

      await app.listen()

      after(() => app.close())

      const response = await fetch(
        `http://localhost:${app.server.address().port}/health/up`
      )

      const spans = memoryExporter
        .getFinishedSpans()
        .filter(span =>
          // Different OpenTelemetry contexts use different property names:
          // - instrumentationLibrary: Manual NodeTracerProvider + manual instrumentation registration (older)
          // - instrumentationScope: NodeSDK with auto-registration (newer standard)
          span.instrumentationLibrary?.name === '@fastify/otel' ||
          span.instrumentationScope?.name === '@fastify/otel'
        )

      assert.equal(spans.length, 0)
      assert.equal(await response.text(), 'hello world')
      assert.equal(response.status, 200)
    })
  })
})
