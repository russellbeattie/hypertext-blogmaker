import fs from 'fs';
import path from 'path';
import http from 'http';
import ejs from 'ejs';
import {fileURLToPath, URL} from 'url';
import {JSDOM} from 'jsdom';
import jsonfeedToRSS from 'jsonfeed-to-rss';
import chokidar from 'chokidar';
import process from 'node:process';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const WORKING_DIR = process.cwd();
const SCRIPT_DIR = __dirname;

const SETTINGS_FILE = path.join(WORKING_DIR, 'settings.json');

let settings = JSON.parse(fs.readFileSync(SETTINGS_FILE).toString());

const DOCS_DIR = path.join(WORKING_DIR, settings.docs_dir_in) + '/';
const WEB_DIR = path.join(WORKING_DIR, settings.web_dir_out) + '/';
const BLOG_DIR = path.join(WEB_DIR, settings.root);
const ASSETS_DIR = path.join(WORKING_DIR, settings.assets_dir) + '/';
const TEMPLATES_DIR = path.join(WORKING_DIR, settings.templates_dir) + '/';

const POSTS_DIR_NAME = 'posts/';

console.log(`
  DOCS_DIR = ${DOCS_DIR}
  WEB_DIR = ${WEB_DIR}
  BLOG_DIR = ${BLOG_DIR}
  TEMPLATES_DIR = ${TEMPLATES_DIR}
  ASSETS_DIR = ${ASSETS_DIR}
`);

let pageData = {};
let posts = {};

let layoutTemplate = fs.readFileSync(TEMPLATES_DIR + 'layout.ejs').toString();

/* *********************** */

const args = process.argv.slice(2)
const command = args[0]

if(command == 'serve'){
  serve(args[1] ? parseInt(args[1]) : 3000)
} else if(command == 'clean'){
  console.log('cleaning ' + BLOG_DIR);
  fs.rmSync(BLOG_DIR, { recursive: true, force: true });
} else {
  build();
}

/* *********************** */

function serve(port) {
  
  build();

  startServer(port)
    
  chokidar.watch([DOCS_DIR, ASSETS_DIR, TEMPLATES_DIR, SETTINGS_FILE]).on('change', async (path, _) => {
    build();
  })
}

/* *********************** */

function build(){

  console.log('cleaning');

  // delete blog dir
  fs.rmSync(BLOG_DIR, { recursive: true, force: true });

  // recursive create folders
  fs.mkdirSync(BLOG_DIR + POSTS_DIR_NAME, {recursive: true});

  console.log('copying assets');

    // copy static assets
  fs.readdirSync(ASSETS_DIR, {withFileTypes: true}).forEach((file) => {
    if(file.name.startsWith('.')){ return; }
    console.log('  ' + ASSETS_DIR + file.name + (file.isDirectory() ? '/*' : ''));
    fs.cpSync(ASSETS_DIR + file.name, BLOG_DIR + file.name, {recursive: true, force: false});
  });

  // copy static post assets
  fs.readdirSync(DOCS_DIR + POSTS_DIR_NAME, {withFileTypes: true}).forEach((file) => {
    if(file.name.startsWith('.') || !file.isDirectory()){ return; }
    console.log('  ' + DOCS_DIR + POSTS_DIR_NAME + file.name + '/*');
    fs.cpSync(DOCS_DIR + POSTS_DIR_NAME + file.name, BLOG_DIR + POSTS_DIR_NAME + file.name, {recursive: true, force: false});
  });

  console.log('reading docs');

  // read/process pages into memory
  fs.readdirSync(DOCS_DIR, {withFileTypes: true}).forEach((file) => {
    if(file.name.startsWith('.') || file.isDirectory()){ return; }
    console.log('  ' + DOCS_DIR + file.name);
    parsePage(file.name);
  });

  // read/process posts into memory
  fs.readdirSync(DOCS_DIR + POSTS_DIR_NAME, {withFileTypes: true}).forEach((file) => {
    if(file.name.startsWith('.') || file.isDirectory()){ return; }
    console.log('  ' + DOCS_DIR + POSTS_DIR_NAME + file.name);
    parsePage(POSTS_DIR_NAME + file.name);
  });
  

  // write out files
  console.log('writing pages to ' + BLOG_DIR);
  createPages()

  console.log('writing feeds');
  createFeeds();

  // done
  console.log('finished');

}

/* *********************** */


function parsePage(filename){
  
  let page = {};

  page.filename = path.basename(filename);
  page.relative = filename;

  let htmlText = fs.readFileSync(DOCS_DIR + filename);

  const dom = new JSDOM(htmlText);
  const $ = (q) => dom.window.document.querySelector(q);

  let jsonEl = $('script[type="application/ld+json"]');
  let jsonLd = {};
  if(jsonEl) {
    try {
      jsonLd = JSON.parse(jsonEl.textContent);
      page.dateCreated = new Date(jsonLd.dateCreated);
      page.dateModified = new Date(jsonLd.dateModified);
    } catch (e) {}
  
  } else {
    let createdEl = $('meta[property="article:published_time"]');
    if(createdEl){
      page.dateCreated = new Date(createdEl.getAttribute('content'));
    }
    let modifiedEl = $('meta[property="article:modified_time"]');
    if(modifiedEl){
      page.dateModified = new Date(modifiedEl.getAttribute('content'));
    }
  }

  if(!page.dateCreated){
      page.dateCreated = new Date();
      page.dateModified = new Date();
  }

  page.postDate = new Intl.DateTimeFormat('en-US', { dateStyle: 'full', timeStyle: 'short' }).format(page.dateCreated);

  page.copyright = '© ' + (new Date(page.dateCreated)).getFullYear();

  page.title = $('title').textContent;
  if(page.title.includes('-')){
    page.title = page.title.substring(0, page.title.indexOf('-')).trim();
  }

  if(page.relative.startsWith(POSTS_DIR_NAME)){
    page.type = 'post';
  } else {
    page.type = 'page';
  }

  if($('img')){
    page.imageUrl = $('img').src;
    page.imageFullUrl = (new URL(page.imageUrl, settings.home_page_url)).toString();
  }

  if($('.post-date')){
    $('.post-date').remove();
  }

  if($('article')){
    page.bodyHTML = $('article').innerHTML;
  } else if($('main')){
    page.bodyHTML = $('main').innerHTML;
  } else {
    page.bodyHTML = $('body').innerHTML;
  }

  if($('p')){
    page.description = $('p').textContent.substring(0,200).replace(/[ |\W]+(?= )/g,'').trim();
  }

  pageData[page.filename] = page;

}

/* *********************** */

function createPages(){

  let postList = Object.keys(pageData).filter(filename => pageData[filename].type == 'post');
  
  postList.sort(function(a, b){
    if(pageData[a].dateCreated > pageData[b].dateCreated){ return 1; }
    if(pageData[a].dateCreated < pageData[b].dateCreated){ return -1; }
    if(pageData[a].dateCreated == pageData[b].dateCreated){ return 0; }
  });

  postList.reverse();

  postList.forEach(function(filename){
    posts[filename] = {
      filename: filename,
      title: pageData[filename].title,
      dateCreated: pageData[filename].dateCreated,
      postDate: pageData[filename].postDate,
    };
  });

  let pageKeys = Object.keys(pageData).sort();

  pageKeys.forEach(function(filename){

    let page = pageData[filename];

    let htmlText = applyTemplates(page);

    fs.writeFileSync(BLOG_DIR + page.relative, htmlText);

  });
    
}


/* *********************** */

function createFeeds(){

  let jsonfeed = {
    "version":"https://jsonfeed.org/version/1",
    "title": settings.title,
    "description": settings.description,
    "home_page_url": settings.home_page_url,
    "feed_url": settings.feed_url,
    "icon": settings.icon,
    "favicon": settings.favicon,
    "author": settings.author,
    "items": [],
  };

  Object.keys(pageData).forEach(function(filename){
    let page = pageData[filename];
    let item = {};

    item.id = (new URL(page.relative, settings.home_page_url)).toString();
    item.url = (new URL(page.relative, settings.home_page_url)).toString();
    item.title = page.title;
    item.content_html = page.bodyHTML;
    if(page.imageFullUrl){
      item.imageUrl = page.imageFullUrl;
    }
    item['date_published'] = page.dateCreated;
    item['date_modified'] = page.dateModified;

    jsonfeed.items.push(item);

  });

  console.log('  ' + BLOG_DIR + 'feed.json');

  fs.writeFileSync(BLOG_DIR + 'feed.json', JSON.stringify(jsonfeed, null, '  '));
  
  console.log('  ' + BLOG_DIR + 'rss.xml');

  fs.writeFileSync(BLOG_DIR + 'rss.xml', jsonfeedToRSS(jsonfeed, {copyright: settings.copyright})); 

}

/* *********************** */

function applyTemplates(page){

  let data = {
    page: page,
    settings: settings,
    posts: posts
  };

  let htmlText = '';

  ejs.renderFile(TEMPLATES_DIR + 'layout.ejs', data, {rmWhitespace: true}, function(err, str){
    if(err){
      console.error(err);
    } else {
      htmlText = str;
    }
  });

  return htmlText;

}

/* *********************** */

function getDateTimeText(dt){

  let y = dt.getFullYear();
  let m = ((dt.getMonth() + 1) + '').padStart(2, '0');  
  let d = (dt.getDate() + '').padStart(2, '0');
  let h = (dt.getHours() + '').padStart(2, '0');
  let t = (dt.getMinutes() + '').padStart(2, '0');

  let dateTime = y + '-' + m + '-' + d+ '-' + h + '-' +  t;

  return dateTime;

}

/* *********************** */

function startServer(port) {

    console.log('Server starting on http://localhost:' + port);

  let mimetypes = {
    '.js': 'application/javascript',
    '.json': 'application/json',
    '.ttf': 'application/octet-stream',
    '.xml': 'application/xml',
    '.jpg': 'image/jpeg',
    '.png': 'image/png',
    '.svg': 'image/svg+xml',
    '.ico': 'image/x-icon',
    '.css': 'text/css',
    '.html': 'text/html'
  };

    http.createServer(function (req, res) {
        
        let pathname = req.url;
        console.log(pathname);

        let filepath = req.url;

        if(filepath == '/'){
          res.writeHead(301, { 'Location': settings.root});
          res.end('<h1>301: Redirect</h1>');
          return;
        }

        if (req.url.endsWith('/')) {
          filepath += 'index.html';
        }

        if(req.url.includes('.') == false && req.url.endsWith('/') == false){
          filepath += '/index.html';
        }

        fs.readFile(WEB_DIR + filepath, function (err, data) {
          if (err) {
              res.writeHead(404);
              res.end('<h1>404: Page not found</h1>');
              return;
          }

          let contentType = mimetypes[path.extname(filepath)];
          if(contentType){
            res.writeHead(200, { 'Content-Type': contentType });
          } else {
            res.writeHead(200);
          }
          res.end(data);

        })
      }).listen(port);
}
