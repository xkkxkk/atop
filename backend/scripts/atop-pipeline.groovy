import groovy.json.JsonSlurperClassic
import groovy.json.JsonOutput

node {
    def runId   = params.ATOP_RUN_ID  ?: env.ATOP_RUN_ID  ?: ''
    def baseUrl = params.ATOP_BASE_URL ?: env.ATOP_BASE_URL ?: ''

    if (!runId || !baseUrl) {
        error "ATOP_RUN_ID and ATOP_BASE_URL are required"
    }

    echo "=========================================="
    echo "ATOP Pipeline Run: ${runId}"
    echo "ATOP Base URL: ${baseUrl}"
    echo "=========================================="

    def configUrl = "${baseUrl}/api/pipeline-runs/${runId}/dispatch-config"
    echo "Fetching config from: ${configUrl}"

    def configJson = sh(script: "curl -sf '${configUrl}'", returnStdout: true).trim()
    def configData = new JsonSlurperClassic().parseText(configJson)
    def result = configData.data ?: configData
    def tasks = result.tasks ?: []

    // Set global environment variables (predefined params + runtime params + global vars)
    def globalEnv = result.globalEnv ?: [:]
    if (globalEnv) {
        echo "Setting ${globalEnv.size()} global env vars"
        globalEnv.each { k, v ->
            env."${k}" = v
            echo "  ${k}=${v}"
        }
    }

    echo "Total tasks: ${tasks.size()}"
    if (tasks.size() == 0) {
        echo "No tasks to execute"
        return
    }

    def completionFlags = [:].asSynchronized()
    def stageConfigs = [:]
    def allNames = []

    for (int i = 0; i < tasks.size(); i++) {
        def task = tasks[i]
        def name = task.testSetName ?: "task-${i}"
        allNames.add(name)

        def dependsOn = []
        if (task.dependsOn != null) {
            for (int d = 0; d < task.dependsOn.size(); d++) {
                def depName = task.dependsOn[d]
                def exists = tasks.find { it.testSetName == depName }
                if (exists) { dependsOn.add(depName) }
            }
        }

        stageConfigs[name] = [
            taskId: task.taskId, agentLabel: task.agentLabel ?: '',
            webhookUrl: task.webhookUrl, priority: task.priority ?: 0,
            dependsOn: dependsOn, skipOnFail: task.skipOnDepFailure ?: false,
            timeout: task.timeout ?: 0, config: task.config,
            envVars: task.envVars ?: [:],
        ]
    }

    echo "========== Execution Plan =========="
    for (int i = 0; i < allNames.size(); i++) {
        def name = allNames[i]
        def sc = stageConfigs[name]
        def depInfo = sc.dependsOn.size() > 0 ? "deps=${sc.dependsOn}" : "no-deps"
        echo "${name} | agent=${sc.agentLabel ?: 'default'} | P${sc.priority} | ${depInfo}"
    }
    echo "===================================="

    def parallelStages = [:]

    for (int i = 0; i < allNames.size(); i++) {
        def stageName = allNames[i]
        def sc = stageConfigs[stageName]
        // Pre-compute webhook URL for use in finally block
        def webhookUrl = sc.webhookUrl
        def taskId = sc.taskId

        parallelStages[stageName] = {
            def startTime = System.currentTimeMillis()
            def taskStatus = "aborted"
            def errorMsg = ""
            def nodeName = ""

            try {
                if (sc.dependsOn.size() > 0) {
                    sh(script: "curl -sf -X POST '${webhookUrl}' -H 'Content-Type: application/json' -d '{\"status\":\"running\",\"task_id\":\"${taskId}\",\"phase\":\"waiting_deps\"}'", returnStatus: true)
                    echo "⏳ ${stageName}: waiting for deps: ${sc.dependsOn}"
                    def maxWait = 7200; def waited = 0
                    while (waited < maxWait) {
                        def allDone = true
                        for (int d = 0; d < sc.dependsOn.size(); d++) {
                            if (!completionFlags.containsKey(sc.dependsOn[d])) { allDone = false; break }
                        }
                        if (allDone) break
                        sleep(5); waited += 5
                    }
                    if (sc.skipOnFail) {
                        for (int d = 0; d < sc.dependsOn.size(); d++) {
                            def ds = completionFlags[sc.dependsOn[d]]
                            if (ds == "FAILED" || ds == "SKIPPED") {
                                echo "⏭ ${stageName}: skipped (dep failed)"
                                completionFlags[stageName] = "SKIPPED"
                                sh(script: "curl -sf -X POST '${webhookUrl}' -H 'Content-Type: application/json' -d '{\"status\":\"aborted\",\"task_id\":\"${taskId}\",\"phase\":\"completed\",\"error_summary\":\"Skipped: dependency failed\"}'", returnStatus: true)
                                return
                            }
                        }
                    }
                    echo "✅ ${stageName}: deps met"
                }

                sh(script: "curl -sf -X POST '${webhookUrl}' -H 'Content-Type: application/json' -d '{\"status\":\"running\",\"task_id\":\"${taskId}\",\"phase\":\"waiting_agent\"}'", returnStatus: true)

                def agentLabel = sc.agentLabel ?: 'built-in'
                node(agentLabel) {
                    nodeName = env.NODE_NAME
                    sh(script: "curl -sf -X POST '${webhookUrl}' -H 'Content-Type: application/json' -d '{\"status\":\"running\",\"task_id\":\"${taskId}\",\"phase\":\"testing\",\"node_name\":\"${nodeName}\"}'", returnStatus: true)

                    stage(stageName) {
                        echo "Running ${stageName} on ${nodeName}"
                        if (sc.envVars) { sc.envVars.each { k, v -> env."${k}" = v } }

                        def config = sc.config
                        if (config) {
                            if (config.setup?.preScript) {
                                sh(script: "curl -sf -X POST '${webhookUrl}' -H 'Content-Type: application/json' -d '{\"status\":\"running\",\"task_id\":\"${taskId}\",\"phase\":\"env_deploy\",\"node_name\":\"${nodeName}\"}'", returnStatus: true)
                                sh config.setup.preScript
                            }
                            sh(script: "curl -sf -X POST '${webhookUrl}' -H 'Content-Type: application/json' -d '{\"status\":\"running\",\"task_id\":\"${taskId}\",\"phase\":\"testing\",\"node_name\":\"${nodeName}\"}'", returnStatus: true)
                            def execCmds = config.execCmds ?: []
                            for (int e = 0; e < execCmds.size(); e++) {
                                def cmd = execCmds[e]
                                if (cmd.cmd) {
                                    echo "Exec: ${cmd.cmdLabel ?: 'step-'+e}"
                                    if (sc.timeout > 0) {
                                        timeout(time: sc.timeout, unit: 'MINUTES') { sh cmd.cmd }
                                    } else {
                                        sh cmd.cmd
                                    }
                                }
                            }
                            if (config.teardown?.postScript) { sh config.teardown.postScript }
                        }
                    }
                }
                taskStatus = "success"
            } catch (Exception e) {
                def msg = e.getMessage() ?: "Unknown error"
                if (msg.contains("Timeout has been exceeded") || msg.contains("timed out")) {
                    taskStatus = "aborted"
                    errorMsg = "Timeout: " + msg.take(200)
                } else if (msg.contains("interrupt") || msg.contains("Aborted") || msg.contains("FlowInterrupted")) {
                    taskStatus = "aborted"
                    errorMsg = msg.take(500)
                } else if (msg.contains("script returned exit code")) {
                    taskStatus = "failed"
                    errorMsg = msg.take(500)
                } else {
                    taskStatus = "failed"
                    errorMsg = msg.take(500)
                }
                echo "❌ ${stageName} ${taskStatus}: ${errorMsg}"
            } finally {
                def duration = System.currentTimeMillis() - startTime
                def flag = taskStatus == "success" ? "SUCCESS" : (taskStatus == "aborted" ? "SKIPPED" : "FAILED")
                completionFlags[stageName] = flag
                echo "${stageName}: ${taskStatus} (${duration}ms)"

                // Determine abort_reason
                def abortReason = ""
                if (taskStatus == "aborted") {
                    if (errorMsg.startsWith("Timeout:")) {
                        abortReason = "timeout"
                    } else if (errorMsg.contains("Aborted by")) {
                        abortReason = "user:" + errorMsg.replaceAll(".*Aborted by ", "").take(50)
                    } else {
                        abortReason = "jenkins:" + errorMsg.take(100)
                    }
                }

                // Inline curl - no method call to avoid CPS issues after abort
                def passRateVal = taskStatus == "success" ? 100.0 : 0.0
                def safeError = errorMsg.replace('"', '\\"').replace("'", "")
                def safeAbortReason = abortReason.replace('"', '\\"').replace("'", "")
                def jsonBody = """{"status":"${taskStatus}","task_id":"${taskId}","phase":"completed","node_name":"${nodeName}","duration_ms":${duration},"pass_rate":${passRateVal},"error_summary":"${safeError}","abort_reason":"${safeAbortReason}"}"""
                try {
                    sh(script: "curl -sf -X POST '${webhookUrl}' -H 'Content-Type: application/json' -d '${jsonBody}'", returnStatus: true)
                } catch (Exception ignored) {
                    echo "Warning: final callback failed for ${taskId}"
                }
            }
        }
    }

    if (parallelStages.size() > 0) {
        try {
            parallel(parallelStages)
        } catch (Exception e) {
            echo "Pipeline interrupted: ${e.getMessage()}"
        }
    }

    echo "=========================================="
    echo "All tasks completed"
    completionFlags.each { name, st -> echo "  ${name}: ${st}" }
    echo "=========================================="
}
