export default {
  title: "walkshop",
  /* The HTTP port. `PORT` in the environment overrides this, and
   * `--port` on the command line overrides both. */
  port: 3600,
  /* The port the isolate's tty portal listens on. Loopback only: the
   * hub in the dev server is its one peer. */
  ws: 3601,
  /* Direct mode: the view leaves the isolate on its console lane, on a
   * second WebSocket the browser dials itself — Node is out of the
   * render path. Events and `"use server"` calls still go via the hub,
   * so nothing is lost but a hop; what is gained is that patches never
   * pass through Node. The console port defaults to `ws + 1`. */
  /* Direct: the view, and the workbench's rows, leave the isolate on
   * its console lane over a second WebSocket the browser dials itself.
   * Node is out of the data path. */
  direct: true,
  /* The model the chat's agent runs, as `yeet.args.model`; `--model`
   * on the command line overrides it. */
  model: "claude-opus-5",
  // console: 3002,
};
