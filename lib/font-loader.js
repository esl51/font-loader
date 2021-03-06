
var _ = require('lodash'),
  Promise = require('bluebird'),
  path = require('path'),
  fs = require('fs'),
  loaderUtils = require('loader-utils'),
  multiplex = require('option-multiplexer'),
  ttf2eot = require('ttf2eot'),
  ttf2woff = require('ttf2woff'),
  ttf2woff2 = require('ttf2woff2'),
  svg2ttf = require('svg2ttf');

var template = _.template(fs.readFileSync(path.join(
  __dirname, '..', 'share', 'font.template'
)));

var extensions = {
    '.ttf': 'truetype',
    '.eot': 'embedded-opentype',
    '.svg': 'svg',
    '.otf': 'opentype',
    '.woff': 'woff',
    '.woff2': 'woff2'
};

var convertors = {
  'svg': {
    'truetype': function(font, data) {
      return svg2ttf(data, { }).buffer;
    }
  },
  'truetype': {
    'woff2': function(font, data) {
      return ttf2woff2(data);
    },
   'woff': function(font, data) {
      return ttf2woff(data, { }).buffer;
    },
    'embedded-opentype': function(font, data) {
      return ttf2eot(data, { }).buffer;
    },
    'opentype': function(font, data) {
      return data;
    }
  },
  'opentype': {
    'woff2': function(font, data) {
      return ttf2woff2(data);
    },
    'woff': function(font, data) {
      return ttf2woff(data, { }).buffer;
    },
    'embedded-opentype': function(font, data) {
      return ttf2eot(data, { }).buffer;
    },
    'truetype': function(font, data) {
      return data;
    }
  }
};

var formats = _.invert(extensions);

function getDefaultFormat(ext) {
  return extensions[ext];
}

function getExtension(format) {
  return formats[format];
}

function createTargets(source, options) {
    options = _.defaults(_.pick(options, 'weight', 'style', 'format', 'stretch'), {
        weight: _.chain(source).pluck('weight').uniq().value(),
        style: _.chain(source).pluck('style').uniq().value(),
        format: _.chain(source).pluck('format').uniq().value(),
        stretch: _.chain(source).pluck('stretch').uniq().value()
    });
    return multiplex(options);
}

function groupFaces(meta, fonts) {
    return _.chain(fonts)
        .groupBy(function(font) {
            return JSON.stringify(_.pick(font, 'weight', 'style', 'stretch'))
        }).map(function(members, key) {
            var props = JSON.parse(key);
            return _.assign(props, {
                name: meta.name,
                files: members
            });
        })
        .value();
}

module.exports = function(input) {


    var _this = this,
        globalQuery = loaderUtils.parseQuery(this.query),
        localQuery = loaderUtils.parseQuery(this.resourceQuery),
        query = _.assign({ }, globalQuery, localQuery),
        base = this.context,
        callback = this.async();

    // Since queries are strings, need to turn weights to ints to get them
    // matched properly
    if (query.weight) {
        if (!_.isArray(query.weight)) {
            query.weight = [ query.weight ];
        }
        query.weight = _.map(query.weight, function(value) {
            return parseInt(value, 10);
        });
    }

    if (query.style) {
        if (!_.isArray(query.style)) {
            query.style = [ query.style ];
        }
    }

    if (query.stretch) {
        if (!_.isArray(query.stretch)) {
            query.stretch = [ query.stretch ];
        }
    }

    function interpolateName(font) {
        var name = [
            _.kebabCase(meta.name),
            font.style,
            font.weight,
            font.stretch
        ].join('-') + '.[hash:8]' + getExtension(font.format);

        // TODO: Should this be globalQuery or localQuery?
        return loaderUtils.interpolateName(_this, name, {
            context: globalQuery.context || _this.options.context,
            content: font.data,
            regExp: globalQuery.regExp
        });
    }

    function emit(font) {
        var name = interpolateName(font);
        _this.emitFile(name, font.data);
        return name;
    }

    this.cacheable();

    // WOW THIS IS HACKY
    if (/\.(css|sass|scss|less)$/.test(this.resourcePath)) {
        callback(null, input);
        return;
    }

    var meta = JSON.parse(input);
    var targets, results;

    function defaults(file) {
        _.defaults(file, {
            weight: 500,
            format: getDefaultFormat(path.extname(file.file)),
            style: 'regular',
            stretch: 'normal',
            data: new Promise(function filePromise(resolve, reject) {
                var filePath = path.join(base, file.file);

                _this.addDependency(filePath);

                fs.readFile(filePath, function fileLoaded(err, data) {
                    return err ? reject(err) : resolve(data);
                });
            })
        });
    }

    _.forEach(meta.files, defaults);
    targets = createTargets(meta.files, query);

    results = _.map(targets, function processTarget(target) {
        var search = _.pick(target, 'weight', 'style', 'stretch'),
            source = _.find(meta.files, search);

        if (!source) {
            // Kevin Rademan: 2017-07-27
            // Rejecting a promise here causes the build to fail because it was 
            // looking for a combination that does not exists in the source files
            // in my case I'd rather not have this break the build 
            // console.log('WARNING: No font for combination ' + JSON.stringify(search));
            return Promise.resolve(null);
            //return Promise.reject('No matching source to ' + query + '.');
        }
        return source.data.then(function dataLoaded(data) {
            return _.assign({
                data: source.format === target.format ?
                    data :
                    convertors[source.format][target.format](target, data)
            }, target);
        }).then(function emitFont(font) {
            font.file = emit(font);
            return font;
        });
    });

    Promise.all(results).then(function fontsGenerated(fonts) {
        fonts = fonts.filter(function(val){ return val !== null});
        var faces = groupFaces(meta, fonts);
        var publicPath = _this.options.output.publicPath || query.basePath || '/';

        callback(null, template({
            faces: faces,
            publicPath: publicPath
        }));
    }).catch(function errored(err) {
        callback(err);
    });
};
