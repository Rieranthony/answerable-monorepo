// The package's public surface: render an email and send it. Nothing here reaches React: the templates are the
// precompiled strings in src/generated, and the React side (src/react.tsx) is for the generator, the preview and the tests.
export { renderEmail, type RenderedEmail } from "./render"
export type { Email, TemplateName } from "./holes"
export {
  createLogTransport,
  createPostmarkTransport,
  postmarkErrorCode,
  type Message,
  type PostmarkTransportOptions,
  type SendResult,
  type Transport,
} from "./transport"
