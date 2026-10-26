'use strict';

var gulp       = require('gulp');
var lint       = require('gulp-eslint-new');
var fs         = require('fs');
var path       = require('path');
var webpack    = require('webpack-stream');
var zip        = require('gulp-zip').default;

function assets(browser) {
    var appAssets = function() {
        return gulp.src(['*.html', 'css/**/*', '_locales/**/*'], {base:".", encoding:false})
            .pipe(gulp.dest('./build/' + browser));
    };
    var iconAssets = function() {
        return gulp.src('icons-store/**/*', {base:'icons-store', encoding:false})
            .pipe(gulp.dest('./build/' + browser + '/icons'));
    };
    var bootstrapAssets = function() {
        return gulp.src('node_modules/chrome-bootstrap/chrome-bootstrap.css')
            .pipe(gulp.dest('./build/' + browser + '/css'));
    };
    return gulp.series(appAssets, iconAssets, bootstrapAssets);
}

function mergeManifest(target, source) {
    Object.keys(source).forEach(function(key) {
        var targetValue = target[key];
        var sourceValue = source[key];
        if(targetValue && sourceValue && typeof targetValue === 'object' && typeof sourceValue === 'object' &&
            !Array.isArray(targetValue) && !Array.isArray(sourceValue)) {
            target[key] = mergeManifest(targetValue, sourceValue);
        } else {
            target[key] = sourceValue;
        }
    });
    return target;
}

function manifest(browser) {
    return async function() {
        var files = [
            path.join(__dirname, 'vendor/common/manifest.json'),
            path.join(__dirname, 'vendor', browser, 'manifest.json')
        ];
        var contents = await Promise.all(files.map(function(file) {
            return fs.promises.readFile(file, 'utf8');
        }));
        var mergedManifest = mergeManifest(JSON.parse(contents[0]), JSON.parse(contents[1]));
        if(browser === 'firefox' && mergedManifest.background) delete mergedManifest.background.service_worker;
        var outputDir = path.join(__dirname, 'build', browser);
        await fs.promises.mkdir(outputDir, { recursive: true });
        await fs.promises.writeFile(path.join(outputDir, 'manifest.json'), JSON.stringify(mergedManifest, null, 4) + '\n');
    }
}

function manifestFile(browser, file) {
    return function() {
        return gulp.src(file)
            .pipe(gulp.dest('./build/' + browser));
    }
}

function build(browser, watch) {
    function bundle(file) {
        return function() {
            return gulp.src('js/' + file + '.js')
                .pipe(webpack({
                    mode: 'production',
                    watch: watch,
                    output: { filename: file + '.js' }
                }))
                .pipe(gulp.dest('./build/' + browser + '/js'));
        };
    }
    return gulp.series(bundle('option'), bundle('extension'), bundle('popin'));
}

function dist(browser) {
    return function() {
        var m = require('./build/' + browser + '/manifest');
        var ext = browser.indexOf('firefox') === 0 ? 'xpi' : 'zip';
        return gulp.src('./build/' + browser + '/**/*', {encoding:false})
            .pipe(zip(browser + '-multipass-' + m.version + '.' + ext))
            .pipe(gulp.dest('./dist'));
    }
}

gulp.task('lint', function() {
    return gulp.src(['js/**.js', 'vendor/**.js'])
        .pipe(lint())
        .pipe(lint.format())
        .pipe(lint.failAfterError());
});

gulp.task('assets-firefox', gulp.series(assets('firefox')));
gulp.task('assets-chrome', gulp.series(assets('chrome')));
gulp.task('assets-opera', gulp.series(assets('opera')));
gulp.task('assets-firefox-android', gulp.series(assets('firefox-android')));

gulp.task('manifest-firefox', gulp.series(manifest('firefox')));
gulp.task('manifest-chrome', gulp.series(manifest('chrome')));
gulp.task('manifest-opera', gulp.series(manifest('opera')));
gulp.task('manifest-firefox-android', gulp.series(manifestFile('firefox-android', './vendor/firefox-android/manifest.json')));

gulp.task('build-firefox', gulp.series('lint', 'assets-firefox', 'manifest-firefox', build('firefox', false)));
gulp.task('build-chrome', gulp.series('lint', 'assets-chrome', 'manifest-chrome', build('chrome', false)));
gulp.task('build-opera', gulp.series('lint', 'assets-opera', 'manifest-opera', build('opera', false)));
gulp.task('build-firefox-android', gulp.series('lint', 'assets-firefox-android', 'manifest-firefox-android', build('firefox-android', false)));
gulp.task('build', gulp.series('build-firefox', 'build-chrome', 'build-opera'));

gulp.task('watch-firefox', gulp.series('assets-firefox', 'manifest-firefox', build('firefox', true)));
gulp.task('watch-chrome', gulp.series('assets-chrome', 'manifest-chrome', build('chrome', true)));
gulp.task('watch-opera', gulp.series('assets-opera', 'manifest-opera', build('opera', true)));
gulp.task('watch', gulp.series('watch-firefox', 'watch-chrome', 'watch-opera'));

gulp.task('dist-firefox', gulp.series('build-firefox', dist('firefox')));
gulp.task('dist-chrome', gulp.series('build-chrome', dist('chrome')));
gulp.task('dist-opera', gulp.series('build-opera', dist('opera')));
gulp.task('dist-firefox-android', gulp.series('build-firefox-android', dist('firefox-android')));
gulp.task('dist', gulp.series('dist-firefox', 'dist-chrome', 'dist-opera'));
