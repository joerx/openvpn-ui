'use strict';

const assert = require('assert');
const fs = require('fs');
const forge = require('node-forge');
const {promisify} = require('util');
const error = require('http-errors');
const moment = require('moment');
const {sprintf} = require('sprintf-js');
const {spawn} = require('child_process');

const {certPaths} = require('./certio');

// Promisified versions of fs library functions
// const writeFile = promisify(fs.writeFile);
const readFile = promisify(fs.readFile);
// const unlink = promisify(fs.unlink);
// const exists = promisify(fs.exists);
// const appendFile = promisify(fs.appendFile);

const asn1date = 'YYMMDDHHmmss[Z]';

// mkcert: ./easyrsa build-client-full $1 nopass

/**
 * Generate client certificate and certificate key for given name. Optionally encrypt the key with
 * a given passphrase.
 *
 * This function is using a file-based locking mechanism - only one certificate can be generated at
 * any given time. Issued certs are registered in index.txt, aiming to be compatible with EasyRSA's
 * revocation mechanism.
 *
 * This is assumed to be sufficiently robust for a small-scale deployment, for larger system a
 * database-backed solution would likely be a better solution.
 */
exports.MkCert = async (config, endpointName, name, passphrase = null) => {
  const paths = certPaths(pkiPath, cn);
  const {cacert, cakey} = config.pki;
  const opensslConf = config.openssl.config;
  const keySize = config.endpoints[endpointName].keysize;

  await genReq(name, keySize, opensslConf, paths);
  await signReq(name, opensslConf, paths);

  return paths;
};


/**
 * Generates an OpenSSL certificate signing request
 */
const genReq = async (cn, keySize, opensslConf, {pkiPath, keyPath, reqPath}) => {
  const args = ['req', '-utf8', '-new',
    '-newkey', `rsa:${keySize}`,
    '-config', opensslConf,
    '-keyout', keyPath,
    '-out', reqPath,
    '-nodes', // no password 
    '-batch'
  ];
  
  await execOpensslCmd(args, pkiPath, cn);
  
  console.log('Key written to', keyPath);
  console.log('Req written to', reqPath);
}


/**
 * Signs an OpenSSL CSR
 */
const signReq = async (cn, opensslConf, {pkiPath, reqPath, certPath}) => {
  const args = ['ca', '-utf8', 
    '-in', reqPath, 
    '-out', certPath,
    '-config', opensslConf, 
    '-batch'
  ];

  await execOpensslCmd(args, pkiPath, cn);
  console.log('Cert written to', certPath);
}


/**
 * Execute a command in the context of the OpenSSL ca generated by easyrsa. Sets up the execution
 * environment to mimic the one provided by the easyrsa tool.
 * 
 * @param {*[]string} args command args
 * @param {*string} pkiPath path to pki initalized by easysa
 * @param {*string} cn common name of the certificate to work with
 */
const execOpensslCmd = (args, pkiPath, cn) => {
  const cmd = '/usr/bin/openssl';

  console.log('Executing',cmd,args.join(' '));

  return new Promise((resolve, reject) => {
    const opts = {
      env: {
        EASYRSA_PKI: pkiPath,
        EASYRSA_CERT_EXPIRE: '3650',
        EASYRSA_CRL_DAYS: '180',
        EASYRSA_DIGEST: 'sha256',
        EASYRSA_KEY_SIZE: '2048',
        EASYRSA_DN: 'cn_only',
        EASYRSA_REQ_CN: cn,
        EASYRSA_REQ_COUNTRY: 'US',
        EASYRSA_REQ_PROVINCE: 'California',
        EASYRSA_REQ_CITY: 'San Francisco',
        EASYRSA_REQ_ORG: 'Copyleft Certificate Co',
        EASYRSA_REQ_OU: 'My Organizational Unit',
        EASYRSA_REQ_EMAIL: 'me@example.net',
      }
    };
    const cp = spawn(cmd, args, opts);

    const parts = [];
    cp.stdout.on('data', b => parts.push(b));
    cp.stderr.on('data', b => parts.push(b));

    cp.on('error', err => {
      cpFail(err, parts);
      reject(err);
    });

    cp.on('exit', code => {
      if (code == 0) {
        console.log('Child process exited with code', code);
        resolve();
      }
      else {
        const err = new Error('Child process exited with code '+code);
        cpFail(err, parts);
        reject(err);
      }
    });
  });
}


const cpFail = (code, out) => {
  console.error('Child process failed, see output below');
  console.error(out.toString('utf-8'));
}


/**
 * List certificates
 * @param {*object} config system config
 */
exports.ListCerts = async (config) => {
  const indexFile = config.pki.index;
  return listCerts(indexFile);
}

const validateCerts = (certs) => {
  assert(certs.privateKey, 'Invalid or missing private key');
  assert(certs.publicKey, 'Invalid or missing public key');
  assert(certs.certificate, 'Invalid certificate');
}

const listCerts = async (indexFile) => {
  const data = await readFile(indexFile, {encoding: 'ascii'});

  return data.split("\n").slice(0, -1).map(line => {
    const [state, exp, serial, _, subject] = line.replace(/\t+/g, ";").split(";");
    // TODO: properly parse X.500 DN?
    const name = subject.match(/\/CN=(\w+)/)[1];
    return {
      state,
      subject,
      name,
      expires: moment(exp, asn1date).toJSON(),
      serial: parseInt(serial),
    }
  });
}
