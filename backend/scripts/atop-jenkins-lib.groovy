import groovy.json.JsonOutput
import groovy.json.JsonSlurperClassic
import javax.crypto.Mac
import javax.crypto.spec.SecretKeySpec

/*
 * ATOP Jenkins shared helpers.
 *
 * Recommended usage:
 * 1. Put this file into a Jenkins Shared Library as vars/atop.groovy.
 * 2. In Jenkinsfile, call:
 *      atop.running(phase: 'build')
 *      atop.success([tag: tag, module: moduleName])
 *
 * Platform requirement:
 * - The ATOP platform triggers Jenkins with an ATOP_PAYLOAD parameter.
 * - ATOP_PAYLOAD contains platform_webhook_url, task_id, run_id and env_vars.
 */

def payload() {
    if (!params.ATOP_PAYLOAD?.trim()) {
        error 'ATOP_PAYLOAD is empty. Please trigger this Jenkins job from ATOP.'
    }
    return new JsonSlurperClassic().parseText(params.ATOP_PAYLOAD)
}

def webhookUrl() {
    def data = payload()
    return data.platform_webhook_url ?: data.webhookUrl ?: ''
}

def running(Map args = [:]) {
    callback([
        status: 'running',
        phase: args.phase ?: 'running',
        node_name: args.nodeName ?: env.NODE_NAME ?: '',
    ])
}

def success(Map outputs = [:]) {
    callback([
        status: 'success',
        outputs: outputs,
    ])
}

def failure(String message = '') {
    callback([
        status: 'failed',
        error_summary: message,
    ])
}

def abort(String reason = '') {
    callback([
        status: 'aborted',
        abort_reason: reason,
        error_summary: reason,
    ])
}

def buildJob(Map args = [:]) {
    def targetJob = args.job
    if (!targetJob?.trim()) {
        error 'job is required'
    }
    def waitForResult = args.containsKey('wait') ? args.wait : true
    def propagateResult = args.containsKey('propagate') ? args.propagate : false
    def jobParams = (args.parameters ?: [:]).collect { k, v ->
        string(name: k.toString(), value: v == null ? '' : v.toString())
    }
    return build job: targetJob, parameters: jobParams, wait: waitForResult, propagate: propagateResult
}

def callback(Map body = [:]) {
    def data = payload()
    def url = data.platform_webhook_url ?: data.webhookUrl
    if (!url?.trim()) {
        error 'ATOP webhook url is empty'
    }

    body.task_id = body.task_id ?: data.task_id ?: env.ATOP_TASK_ID ?: ''
    body.jenkins_build_id = currentBuild.number
    body.jenkins_build_url = env.BUILD_URL ?: ''
    body.duration_ms = body.duration_ms ?: 0
    body.pass_rate = body.status == 'success' ? 100.0 : 0.0

    def json = JsonOutput.toJson(body)
    writeFile file: '.atop-callback.json', text: json

    def headers = "-H 'Content-Type: application/json'"
    def secret = env.ATOP_WEBHOOK_SECRET ?: ''
    if (secret.trim()) {
        headers += " -H 'X-Atop-Signature: ${hmacSha256(secret, json)}'"
    }
    sh "curl -sS -X POST '${url}' ${headers} --data-binary @.atop-callback.json --max-time 15 --retry 2"
}

String hmacSha256(String secret, String body) {
    Mac mac = Mac.getInstance('HmacSHA256')
    mac.init(new SecretKeySpec(secret.getBytes('UTF-8'), 'HmacSHA256'))
    return mac.doFinal(body.getBytes('UTF-8')).encodeHex().toString()
}

