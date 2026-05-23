package scheduler

import (
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"regexp"
	"strconv"
	"strings"
	"time"

	"github.com/company/atop-backend/internal/config"
	"github.com/company/atop-backend/internal/model"
	"github.com/company/atop-backend/internal/util"
	"github.com/company/atop-backend/pkg/logger"
	"go.uber.org/zap"
)

var queueItemPathPattern = regexp.MustCompile(`/queue/item/(\d+)(?:/|$)`)

type QueueItemExistsError struct {
	QueueID int64
	Body    string
}

func (e *QueueItemExistsError) Error() string {
	if e == nil {
		return "jenkins queue item already exists"
	}
	if e.QueueID > 0 {
		return fmt.Sprintf("jenkins queue item already exists: queue %d", e.QueueID)
	}
	if strings.TrimSpace(e.Body) != "" {
		return "jenkins queue item already exists: " + e.Body
	}
	return "jenkins queue item already exists"
}

// JenkinsClient wraps HTTP calls to a Jenkins instance.
type JenkinsClient struct {
	instance *model.JenkinsInstance
	apiToken string
	http     *http.Client
}

func NewJenkinsClient(inst *model.JenkinsInstance) (*JenkinsClient, error) {
	token, err := util.Decrypt(inst.APITokenEncrypted)
	if err != nil {
		return nil, fmt.Errorf("decrypt api token: %w", err)
	}
	return &JenkinsClient{
		instance: inst,
		apiToken: token,
		http:     &http.Client{Timeout: config.Global.Jenkins.RequestTimeout},
	}, nil
}

func (c *JenkinsClient) baseURL() string {
	return strings.TrimRight(c.instance.URL, "/")
}

func jobPath(jobName string) string {
	raw := strings.TrimSpace(jobName)
	fromURL := false
	if u, err := url.Parse(raw); err == nil && u.Scheme != "" && u.Host != "" {
		raw = u.Path
		fromURL = true
	}
	if fromURL {
		if idx := strings.Index(raw, "/job/"); idx >= 0 {
			raw = raw[idx:]
		}
	}
	parts := strings.Split(strings.Trim(raw, "/"), "/")
	segments := make([]string, 0, len(parts)*2)
	for i := 0; i < len(parts); i++ {
		part := strings.TrimSpace(parts[i])
		if part == "" {
			continue
		}
		if strings.EqualFold(part, "job") && i+1 < len(parts) {
			next := strings.TrimSpace(parts[i+1])
			if next != "" {
				if decoded, err := url.PathUnescape(next); err == nil {
					next = decoded
				}
				segments = append(segments, "job", url.PathEscape(next))
				i++
			}
			continue
		}
		if decoded, err := url.PathUnescape(part); err == nil {
			part = decoded
		}
		segments = append(segments, "job", url.PathEscape(part))
	}
	if len(segments) == 0 {
		return "/job/"
	}
	return "/" + strings.Join(segments, "/")
}

func queueIDFromLocation(location string) int64 {
	if location == "" {
		return 0
	}
	if u, err := url.Parse(location); err == nil {
		parts := strings.Split(strings.Trim(u.Path, "/"), "/")
		for i := 0; i+2 < len(parts); i++ {
			if parts[i] == "queue" && parts[i+1] == "item" {
				id, _ := strconv.ParseInt(parts[i+2], 10, 64)
				return id
			}
		}
	}
	return 0
}

func queueIDFromBody(body string) int64 {
	if body == "" {
		return 0
	}
	if id := queueIDFromLocation(body); id > 0 {
		return id
	}
	match := queueItemPathPattern.FindStringSubmatch(body)
	if len(match) < 2 {
		return 0
	}
	id, _ := strconv.ParseInt(match[1], 10, 64)
	return id
}

func (c *JenkinsClient) addCrumb(req *http.Request) error {
	endpoint := c.baseURL() + "/crumbIssuer/api/json"
	crumbReq, err := http.NewRequest("GET", endpoint, nil)
	if err != nil {
		return err
	}
	crumbReq.SetBasicAuth(c.instance.Username, c.apiToken)

	resp, err := c.http.Do(crumbReq)
	if err != nil {
		return fmt.Errorf("jenkins crumb: %w", err)
	}
	defer resp.Body.Close()

	// Jenkins returns 404 when CSRF crumbs are disabled; in that case no header is needed.
	if resp.StatusCode == http.StatusNotFound {
		return nil
	}
	if resp.StatusCode >= 400 {
		body, _ := io.ReadAll(resp.Body)
		return fmt.Errorf("jenkins crumb failed [%d]: %s", resp.StatusCode, strings.TrimSpace(string(body)))
	}

	var result struct {
		CrumbRequestField string `json:"crumbRequestField"`
		Crumb             string `json:"crumb"`
	}
	body, _ := io.ReadAll(resp.Body)
	if err := json.Unmarshal(body, &result); err != nil {
		return err
	}
	if result.CrumbRequestField != "" && result.Crumb != "" {
		req.Header.Set(result.CrumbRequestField, result.Crumb)
	}
	return nil
}

func shouldFallbackToBuild(status int, body string) bool {
	lower := strings.ToLower(body)
	return status == http.StatusNotFound ||
		status == http.StatusMethodNotAllowed ||
		(status == http.StatusBadRequest && strings.Contains(lower, "parameter"))
}

func isQueueItemExistsBody(body string) bool {
	lower := strings.ToLower(strings.TrimSpace(body))
	return strings.Contains(lower, "queue item exists") ||
		strings.Contains(lower, "already in queue") ||
		strings.Contains(lower, "already queued")
}

func (c *JenkinsClient) postBuild(endpoint string, body io.Reader, contentType string) (int64, int, string, error) {
	req, err := http.NewRequest("POST", endpoint, body)
	if err != nil {
		return 0, 0, "", err
	}
	req.SetBasicAuth(c.instance.Username, c.apiToken)
	if contentType != "" {
		req.Header.Set("Content-Type", contentType)
	}
	if err := c.addCrumb(req); err != nil {
		return 0, 0, "", err
	}

	resp, err := c.http.Do(req)
	if err != nil {
		return 0, 0, "", fmt.Errorf("jenkins trigger: %w", err)
	}
	defer resp.Body.Close()

	respBody, _ := io.ReadAll(resp.Body)
	text := strings.TrimSpace(string(respBody))
	bodyQueueID := queueIDFromBody(text)
	if isQueueItemExistsBody(text) {
		return 0, resp.StatusCode, text, &QueueItemExistsError{QueueID: bodyQueueID, Body: text}
	}
	if resp.StatusCode >= 200 && resp.StatusCode < 300 {
		queueID := queueIDFromLocation(resp.Header.Get("Location"))
		if queueID > 0 {
			return queueID, resp.StatusCode, text, nil
		}
		if bodyQueueID > 0 {
			return 0, resp.StatusCode, text, &QueueItemExistsError{QueueID: bodyQueueID, Body: text}
		}
		if resp.StatusCode == http.StatusCreated {
			return 0, resp.StatusCode, text, nil
		}
		return 0, resp.StatusCode, text, fmt.Errorf("jenkins trigger accepted [%d] but did not return queue id: %s", resp.StatusCode, text)
	}

	return 0, resp.StatusCode, text, fmt.Errorf("jenkins trigger failed [%d]: %s", resp.StatusCode, text)
}

// JobExists checks whether a Jenkins job exists and is readable by the token.
func (c *JenkinsClient) JobExists(jobName string) error {
	endpoint := c.baseURL() + jobPath(jobName) + "/api/json?tree=name"
	req, err := http.NewRequest("GET", endpoint, nil)
	if err != nil {
		return err
	}
	req.SetBasicAuth(c.instance.Username, c.apiToken)

	resp, err := c.http.Do(req)
	if err != nil {
		return fmt.Errorf("jenkins job check: %w", err)
	}
	defer resp.Body.Close()

	if resp.StatusCode == http.StatusNotFound {
		return fmt.Errorf("Jenkins Job 不存在或当前账号无权访问：%s", jobName)
	}
	if resp.StatusCode >= 400 {
		body, _ := io.ReadAll(resp.Body)
		return fmt.Errorf("Jenkins Job 校验失败 [%d]: %s", resp.StatusCode, strings.TrimSpace(string(body)))
	}
	return nil
}

// TriggerJob triggers a Jenkins parameterized job and returns the queue item ID.
func (c *JenkinsClient) TriggerJob(jobName string, params map[string]string) (int64, error) {
	jobURL := c.baseURL() + jobPath(jobName)

	form := url.Values{}
	for k, v := range params {
		form.Set(k, v)
	}

	queueID, status, body, err := c.postBuild(jobURL+"/buildWithParameters", strings.NewReader(form.Encode()), "application/x-www-form-urlencoded")
	if err == nil {
		return queueID, nil
	}
	var queueExists *QueueItemExistsError
	if errors.As(err, &queueExists) {
		return 0, err
	}

	// Some Jenkins jobs are not parameterized and only accept /build.
	if shouldFallbackToBuild(status, body) {
		queueID, _, fallbackBody, fallbackErr := c.postBuild(jobURL+"/build", nil, "")
		if fallbackErr == nil {
			return queueID, nil
		}
		if errors.As(fallbackErr, &queueExists) {
			return 0, fallbackErr
		}
		return 0, fmt.Errorf("%w; fallback /build failed: %s", err, fallbackBody)
	}
	return 0, err
}

// QueueItemStatus represents a Jenkins queue item.
type QueueItemStatus struct {
	Blocked    bool `json:"blocked"`
	Buildable  bool `json:"buildable"`
	Cancelled  bool `json:"cancelled"`
	Stuck      bool `json:"stuck"`
	Why        string `json:"why"`
	Executable *struct {
		Number int64  `json:"number"`
		URL    string `json:"url"`
	} `json:"executable"`
}

type BuildRef struct {
	Number   int64
	URL      string
	Building bool
	Result   string
}

func buildRefFromAPI(number int64, url string, building bool, result string) *BuildRef {
	return &BuildRef{
		Number:   number,
		URL:      url,
		Building: building,
		Result:   result,
	}
}

// CheckQueueItem polls a queue item and returns build number if started.
func (c *JenkinsClient) CheckQueueItem(queueID int64) (*QueueItemStatus, error) {
	if queueID <= 0 {
		return nil, fmt.Errorf("invalid Jenkins queue id: %d", queueID)
	}
	endpoint := fmt.Sprintf("%s/queue/item/%d/api/json", c.baseURL(), queueID)
	req, _ := http.NewRequest("GET", endpoint, nil)
	req.SetBasicAuth(c.instance.Username, c.apiToken)

	resp, err := c.http.Do(req)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()

	body, _ := io.ReadAll(resp.Body)
	if resp.StatusCode >= 400 {
		return nil, fmt.Errorf("jenkins queue check failed [%d]: %s", resp.StatusCode, strings.TrimSpace(string(body)))
	}
	var status QueueItemStatus
	if err := json.Unmarshal(body, &status); err != nil {
		return nil, err
	}
	return &status, nil
}

func (c *JenkinsClient) FindBuildByQueueID(jobName string, queueID int64) (*BuildRef, error) {
	if queueID <= 0 {
		return nil, fmt.Errorf("invalid Jenkins queue id: %d", queueID)
	}
	endpoint := fmt.Sprintf("%s%s/api/json?tree=builds[number,url,queueId,building,result]", c.baseURL(), jobPath(jobName))
	req, _ := http.NewRequest("GET", endpoint, nil)
	req.SetBasicAuth(c.instance.Username, c.apiToken)

	resp, err := c.http.Do(req)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()

	body, _ := io.ReadAll(resp.Body)
	if resp.StatusCode >= 400 {
		return nil, fmt.Errorf("jenkins build lookup failed [%d]: %s", resp.StatusCode, strings.TrimSpace(string(body)))
	}

	var result struct {
		Builds []struct {
			Number   int64  `json:"number"`
			URL      string `json:"url"`
			QueueID  int64  `json:"queueId"`
			Building bool   `json:"building"`
			Result   string `json:"result"`
		} `json:"builds"`
	}
	if err := json.Unmarshal(body, &result); err != nil {
		return nil, err
	}
	for _, build := range result.Builds {
		if build.QueueID != queueID {
			continue
		}
		return buildRefFromAPI(build.Number, build.URL, build.Building, build.Result), nil
	}
	return nil, nil
}

func (c *JenkinsClient) FindBuildByParameters(jobName string, expected map[string]string) (*BuildRef, error) {
	if len(expected) == 0 {
		return nil, nil
	}
	endpoint := fmt.Sprintf("%s%s/api/json?tree=builds[number,url,queueId,building,result,actions[parameters[name,value]]]", c.baseURL(), jobPath(jobName))
	req, _ := http.NewRequest("GET", endpoint, nil)
	req.SetBasicAuth(c.instance.Username, c.apiToken)

	resp, err := c.http.Do(req)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()

	body, _ := io.ReadAll(resp.Body)
	if resp.StatusCode >= 400 {
		return nil, fmt.Errorf("jenkins build lookup failed [%d]: %s", resp.StatusCode, strings.TrimSpace(string(body)))
	}

	var result struct {
		Builds []struct {
			Number   int64  `json:"number"`
			URL      string `json:"url"`
			Building bool   `json:"building"`
			Result   string `json:"result"`
			Actions  []struct {
				Parameters []struct {
					Name  string `json:"name"`
					Value any    `json:"value"`
				} `json:"parameters"`
			} `json:"actions"`
		} `json:"builds"`
	}
	if err := json.Unmarshal(body, &result); err != nil {
		return nil, err
	}
	for _, build := range result.Builds {
		actual := make(map[string]string)
		for _, action := range build.Actions {
			for _, param := range action.Parameters {
				if strings.TrimSpace(param.Name) != "" {
					actual[param.Name] = fmt.Sprint(param.Value)
				}
			}
		}
		matched := true
		for key, value := range expected {
			if strings.TrimSpace(key) == "" || actual[key] != value {
				matched = false
				break
			}
		}
		if matched {
			return buildRefFromAPI(build.Number, build.URL, build.Building, build.Result), nil
		}
	}
	return nil, nil
}

// AbortBuild sends an abort request for a running build.
func (c *JenkinsClient) AbortBuild(jobName string, buildID int64) error {
	endpoint := fmt.Sprintf("%s%s/%d/stop", c.baseURL(), jobPath(jobName), buildID)
	req, _ := http.NewRequest("POST", endpoint, nil)
	req.SetBasicAuth(c.instance.Username, c.apiToken)
	if err := c.addCrumb(req); err != nil {
		return err
	}

	resp, err := c.http.Do(req)
	if err != nil {
		return err
	}
	resp.Body.Close()
	return nil
}

// GetBuildInfo retrieves build metadata.
func (c *JenkinsClient) GetBuildInfo(jobName string, buildID int64) (map[string]any, error) {
	endpoint := fmt.Sprintf("%s%s/%d/api/json", c.baseURL(), jobPath(jobName), buildID)
	req, _ := http.NewRequest("GET", endpoint, nil)
	req.SetBasicAuth(c.instance.Username, c.apiToken)

	resp, err := c.http.Do(req)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()

	var result map[string]any
	body, _ := io.ReadAll(resp.Body)
	json.Unmarshal(body, &result)
	return result, nil
}

// SyncNodes fetches all nodes/agents from Jenkins and returns them.
func (c *JenkinsClient) SyncNodes() ([]map[string]any, error) {
	endpoint := fmt.Sprintf("%s/computer/api/json?tree=computer[displayName,offline,assignedLabels[name],monitorData[*]]", c.baseURL())
	req, _ := http.NewRequest("GET", endpoint, nil)
	req.SetBasicAuth(c.instance.Username, c.apiToken)

	resp, err := c.http.Do(req)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()

	var result struct {
		Computer []map[string]any `json:"computer"`
	}
	body, _ := io.ReadAll(resp.Body)
	if err := json.Unmarshal(body, &result); err != nil {
		return nil, err
	}
	return result.Computer, nil
}

// Ping checks Jenkins connectivity and returns version string.
func (c *JenkinsClient) Ping() (string, time.Duration, error) {
	start := time.Now()
	endpoint := c.baseURL() + "/api/json?tree=version"
	req, _ := http.NewRequest("GET", endpoint, nil)
	req.SetBasicAuth(c.instance.Username, c.apiToken)

	resp, err := c.http.Do(req)
	latency := time.Since(start)
	if err != nil {
		return "", latency, err
	}
	defer resp.Body.Close()

	if resp.StatusCode >= 400 {
		return "", latency, fmt.Errorf("jenkins returned %d", resp.StatusCode)
	}

	var result struct{ Version string `json:"version"` }
	body, _ := io.ReadAll(resp.Body)
	json.Unmarshal(body, &result)

	version := resp.Header.Get("X-Jenkins")
	if version == "" {
		version = result.Version
	}
	logger.Debug("jenkins ping", zap.String("url", c.instance.URL), zap.Duration("latency", latency))
	return version, latency, nil
}

// WaitForBuildID polls the Jenkins queue item until a build ID is assigned.
func (c *JenkinsClient) WaitForBuildID(jobName string, queueID int64, timeout time.Duration) (int64, string) {
	if queueID <= 0 {
		return 0, ""
	}
	deadline := time.Now().Add(timeout)
	for time.Now().Before(deadline) {
		url := fmt.Sprintf("%s/queue/item/%d/api/json", c.baseURL(), queueID)
		req, err := http.NewRequest("GET", url, nil)
		if err != nil {
			time.Sleep(3 * time.Second)
			continue
		}
		req.SetBasicAuth(c.instance.Username, c.apiToken)
		resp, err := c.http.Do(req)
		if err != nil {
			time.Sleep(3 * time.Second)
			continue
		}
		body, _ := io.ReadAll(resp.Body)
		resp.Body.Close()
		if resp.StatusCode >= 400 {
			if resp.StatusCode == http.StatusNotFound {
				if build, err := c.FindBuildByQueueID(jobName, queueID); err == nil && build != nil && build.Number > 0 {
					return build.Number, build.URL
				}
			}
			time.Sleep(3 * time.Second)
			continue
		}

		var result struct {
			Executable struct {
				Number int64  `json:"number"`
				URL    string `json:"url"`
			} `json:"executable"`
			Cancelled bool `json:"cancelled"`
		}
		json.Unmarshal(body, &result)

		if result.Cancelled {
			return 0, ""
		}
		if result.Executable.Number > 0 {
			return result.Executable.Number, result.Executable.URL
		}
		time.Sleep(3 * time.Second)
	}
	return 0, ""
}
