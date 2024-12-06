process.env.SENTRY_DSN =
  process.env.SENTRY_DSN ||
  'https://783765ad8f0542ce9d961b2ef487cd57@errors.cozycloud.cc/20'

const {
  BaseKonnector,
  requestFactory,
  log,
  errors,
  utils,
  cozyClient
} = require('cozy-konnector-libs')

const models = cozyClient.new.models
const { Qualification } = models.document

const request = requestFactory({
  // debug: true,
  json: true,
  jar: true
})

const crypto = require('crypto')

const VENDOR = 'Ensap'
const baseUrl = 'https://ensap.gouv.fr'

module.exports = new BaseKonnector(start)

async function start(fields) {
  await this.deactivateAutoSuccessfulLogin()
  await authenticate(fields.login, fields.password)
  await this.notifySuccessfulLogin()

  const { yearsPaie, yearsPension } = await getYears()
  if (yearsPaie) {
    log('info', 'Found Remuneration type docs, fetching them...')
    for (const yearPaie of yearsPaie) {
      const files = await fetchFiles(yearPaie)
      const { docs, bills } = await parseDocuments(files, 'paie')
      if (bills.length)
        // We update the isRefund attribute if missing due to 1.5.0
        await this.saveBills(bills, fields, {
          fileIdAttributes: ['vendorRef'],
          identifiers: ['ddfip', 'drfip', 'paye', 'remuneration'],
          shouldUpdate: function (newBill, dbEntry) {
            const result = newBill.isRefund && !dbEntry.isRefund
            return result
          },
          // Now needed to avoid MIMETYPE errors
          validateFile: () => true
        })

      if (docs.length)
        await this.saveFiles(docs, fields, {
          contentType: 'application/pdf',
          fileIdAttributes: ['vendorRef'],
          identifiers: ['ddfip', 'drfip', 'paye', 'remuneration'],
          // Now needed to avoid MIMETYPE errors
          validateFile: () => true
        })
    }
  }
  if (yearsPension) {
    log('info', 'Found Pension type docs, fetching them...')
    for (const yearPension of yearsPension) {
      const files = await fetchFilesPension(yearPension)
      const { docs, bills } = await parseDocuments(files, 'pension')
      if (bills.length)
        await this.saveBills(bills, fields, {
          fileIdAttributes: ['vendorRef']
        })

      if (docs.length)
        await this.saveFiles(docs, fields, {
          contentType: 'application/pdf',
          fileIdAttributes: ['vendorRef']
        })
    }
  }
}
async function authenticate(login, password) {
  const resp = await request({
    uri: `${baseUrl}/`,
    method: 'POST',
    Headers: { 'Content-Type': 'application/json' },
    formData: { identifiant: login, secret: password },
    resolveWithFullResponse: true
  })

  const respBody = resp.body
  if (respBody.message.includes('ou mot de passe')) {
    throw new Error(errors.LOGIN_FAILED)
  } else if (
    respBody.message.includes('Authentification OK') &&
    resp.statusCode === 200
  ) {
    return
  } else if (respBody.message.includes('bloqué')) {
    log('error', respBody)
    throw new Error('LOGIN_FAILED.TOO_MANY_ATTEMPTS')
  } else {
    log('error', respBody)
    throw new Error(errors.VENDOR_DOWN)
  }
}

async function getYears() {
  let yearsLists = {}
  // Set up XSRF-Token
  const xsrfReq = await request({
    uri: `${baseUrl}/prive/initialiserhabilitation/v1`,
    method: 'POST',
    body: {},
    resolveWithFullResponse: true
  })
  const hasRemunaration = xsrfReq.body.listeService?.remuneration
  const hasPension = xsrfReq.body.listeService?.pension
  let paieYearsList
  let pensionYearsList
  if (hasRemunaration) {
    log('info', 'Found "remuneration" for this user, processing ...')
    const paieResp = await request({
      uri: `${baseUrl}/prive/listeranneeremunerationpaie/v1`,
      method: 'GET',
      resolveWithFullResponse: true
    })
    paieYearsList = paieResp.body.listeAnnee
    if (paieYearsList) {
      paieYearsList = paieYearsList.sort().reverse()
      yearsLists.yearsPaie = paieYearsList
    }
  }
  if (hasPension) {
    log('info', 'Found "pension" for this user, processing ...')
    const pensionResp = await request({
      uri: `${baseUrl}/prive/listeranneeremunerationpension/v1`,
      method: 'GET',
      resolveWithFullResponse: true
    })
    pensionYearsList = pensionResp.body.listeAnnee
    if (pensionYearsList) {
      pensionYearsList = pensionYearsList.sort().reverse()
      yearsLists.yearsPension = pensionYearsList
    }
  }
  log('info', `yearsPaie length : ${yearsLists.yearsPaie?.length}`)
  log('info', ` yearsPension length: ${yearsLists.yearsPension?.length}`)
  return yearsLists
}

function fetchFiles(year) {
  log('info', `Fetching files paie for year ${year}`)
  return request.get(`${baseUrl}/prive/remunerationpaie/v1?annee=${year}`, {
    json: true
  })
}

function fetchFilesPension(year) {
  log('info', `Fetching files pension for year ${year}`)
  return request.get(`${baseUrl}/prive/remunerationpension/v1?annee=${year}`, {
    json: true
  })
}

async function parseDocuments(files, type = 'paie') {
  const docs = []
  const bills = []
  for (const file of files) {
    // For each file get the pdf url and metadata
    const uuid = file.documentUuid
    // Switching url if we have pension documents
    let fileurl = `${baseUrl}/prive/telechargerremunerationpaie/v1?documentUuid=${uuid}`
    if (type === 'pension') {
      fileurl = `${baseUrl}/prive/telechargerremunerationpension/v1?documentUuid=${uuid}`
    }
    let filename = file.libelle2.split(' (PDF')[0]
    filename = handleFileName(filename, type, uuid)

    // Added on 18-04-2024 => To remove in several month, when the majority of users will have had the correction
    let filenameToChange = file.libelle2
    filenameToChange = handleFileName(filenameToChange, type, uuid)
    // ///////////////////////////////////////////////

    // Date is set to 22 of the month for easier matching, if not BP is always at 1st
    let datePlus21 = new Date(file.dateDocument)
    datePlus21.setDate(datePlus21.getDate() + 21)
    const amount = parseFloat(file.libelle3?.replace(' ', '').replace(',', '.'))
    const vendor = VENDOR
    // This doc have no amount in libelle3, make a file only.
    if (filename.includes('rappel') || filename.includes('Attestation')) {
      const doc = {
        fileurl,
        filename,
        shouldReplaceName: filenameToChange,
        vendorRef: uuid,
        fileAttributes: {
          metadata: {
            datetime: utils.formatDate(new Date()),
            datetimeLabel: 'issueDate',
            contentAuthor: 'ensap.gouv.fr',
            carbonCopy: true,
            qualification: Qualification.getByLabel('other_revenue')
          }
        }
      }
      docs.push(doc)
    } else if (filename.includes('Bulletin') && Boolean(amount)) {
      // This doc have amount, it's a bill !
      const doc = {
        date: datePlus21,
        fileurl,
        filename,
        shouldReplaceName: filenameToChange,
        amount,
        isRefund: true,
        vendor,
        vendorRef: uuid,
        type: 'income',
        fileAttributes: {
          metadata: {
            datetime: utils.formatDate(new Date()),
            datetimeLabel: 'issueDate',
            contentAuthor: 'ensap.gouv.fr',
            carbonCopy: true,
            qualification: Qualification.getByLabel('pay_sheet')
          }
        }
      }
      bills.push(doc)
    } else {
      log('warn', `Unqualified type for one doc: ${filename}`)
      const doc = {
        fileurl,
        filename,
        shouldReplaceName: filenameToChange,
        vendorRef: uuid,
        fileAttributes: {
          metadata: {
            datetime: utils.formatDate(new Date()),
            datetimeLabel: 'issueDate',
            contentAuthor: 'ensap.gouv.fr',
            carbonCopy: true
          }
        }
      }
      docs.push(doc)
    }
  }
  return { docs, bills }
}

function handleFileName(filename, type = 'paie', uuid) {
  log('info', 'handleFilename starts')
  let filenameResult
  // Try to replace _XX_ known type_
  filenameResult = filename.replace(/_AF_/, '_Attestation_fiscale_')
  filenameResult = filenameResult.replace(/_AFENS_/, '_Attestation_fiscale_')
  filenameResult = filenameResult.replace(/_AFPENS_/, '_Attestation_fiscale_')
  filenameResult = filenameResult.replace(/_DR_/, '_Décompte_de_rappel_')
  if (type === 'pension') {
    filenameResult = filenameResult.replace(/_BP_/, '_Bulletin_de_pension_')
    filenameResult = filenameResult.replace(/_BPENS_/, '_Bulletin_de_pension_')
  } else {
    filenameResult = filenameResult.replace(/_BP_/, '_Bulletin_de_paie_')
    filenameResult = filenameResult.replace(/_BPENS_/, '_Bulletin_de_paie_')
  }
  return filenameResult.replace(
    /\.pdf$/,
    `_${crypto.createHash('sha1').update(uuid).digest('hex').substr(0, 5)}.pdf`
  )
}
