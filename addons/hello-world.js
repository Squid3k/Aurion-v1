// hello-world.js
module.exports = {
  register(app) {
    app.get('/addon/hello', (_req, res) => {
      res.json({ ok: true, msg: "Hello from an Aurion add-on!" });
    });
  }
};
