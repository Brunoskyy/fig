var path = require('path');
var fs = require('fs');
var DatabaseSync = process.getBuiltinModule('node:sqlite').DatabaseSync;
var quayside = require('./app');

var file = process.env.QUAYSIDE_DB || path.join(__dirname, '..', 'data', 'quayside.db');
fs.mkdirSync(path.dirname(file), { recursive: true });
var raw = new DatabaseSync(file);
quayside.migrate(raw);

var port = process.env.PORT || 4100;
quayside.createApp(raw).listen(port, function () {
  console.log('quayside ' + quayside.VERSION + ' listening on ' + port);
});
