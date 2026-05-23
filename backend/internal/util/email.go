package util

import (
	"crypto/tls"
	"fmt"
	"net"
	"net/smtp"
	"strings"
)

// SendEmail sends an email via SMTP with TLS support.
func SendEmail(host string, port int, username, password, from, to, subject, htmlBody, security string) error {
	addr := fmt.Sprintf("%s:%d", host, port)
	security = strings.ToLower(strings.TrimSpace(security))
	if security == "" || security == "auto" {
		if port == 465 {
			security = "ssl"
		} else if port == 587 {
			security = "starttls"
		} else {
			security = "none"
		}
	}

	auth := smtp.PlainAuth("", username, password, host)

	msg := strings.Join([]string{
		"MIME-Version: 1.0",
		"Content-Type: text/html; charset=UTF-8",
		fmt.Sprintf("From: ATOP平台 <%s>", from),
		fmt.Sprintf("To: %s", to),
		fmt.Sprintf("Subject: %s", subject),
		"",
		htmlBody,
	}, "\r\n")

	if security == "ssl" {
		tlsCfg := &tls.Config{ServerName: host, InsecureSkipVerify: false}
		conn, err := tls.Dial("tcp", addr, tlsCfg)
		if err != nil {
			// Try with InsecureSkipVerify for internal SMTP servers
			tlsCfg.InsecureSkipVerify = true
			conn, err = tls.Dial("tcp", addr, tlsCfg)
			if err != nil {
				return fmt.Errorf("TLS连接失败: %w", err)
			}
		}
		defer conn.Close()
		client, err := smtp.NewClient(conn, host)
		if err != nil {
			return fmt.Errorf("SMTP客户端创建失败: %w", err)
		}
		defer client.Close()
		if err = client.Auth(auth); err != nil {
			return fmt.Errorf("SMTP认证失败: %w", err)
		}
		if err = client.Mail(from); err != nil {
			return err
		}
		if err = client.Rcpt(to); err != nil {
			return err
		}
		w, err := client.Data()
		if err != nil {
			return err
		}
		_, err = fmt.Fprint(w, msg)
		if err != nil {
			return err
		}
		return w.Close()
	}

	conn, err := net.Dial("tcp", addr)
	if err != nil {
		return fmt.Errorf("SMTP连接失败: %w", err)
	}
	defer conn.Close()

	client, err := smtp.NewClient(conn, host)
	if err != nil {
		return fmt.Errorf("SMTP客户端创建失败: %w", err)
	}
	defer client.Close()

	if security == "starttls" {
		tlsCfg := &tls.Config{ServerName: host, InsecureSkipVerify: false}
		if ok, _ := client.Extension("STARTTLS"); !ok {
			return fmt.Errorf("SMTP服务器不支持STARTTLS")
		}
		if err = client.StartTLS(tlsCfg); err != nil {
			return fmt.Errorf("STARTTLS握手失败: %w", err)
		}
	}

	if err = client.Auth(auth); err != nil {
		return fmt.Errorf("SMTP认证失败: %w", err)
	}
	if err = client.Mail(from); err != nil {
		return err
	}
	if err = client.Rcpt(to); err != nil {
		return err
	}
	w, err := client.Data()
	if err != nil {
		return err
	}
	if _, err = fmt.Fprint(w, msg); err != nil {
		return err
	}
	return w.Close()
}

// ResetPasswordEmailHTML generates the HTML email body for password reset.
func ResetPasswordEmailHTML(username, resetURL string, expireMinutes int) string {
	return fmt.Sprintf(`<!DOCTYPE html>
<html>
<head><meta charset="UTF-8"></head>
<body style="font-family:'PingFang SC','Microsoft YaHei',sans-serif;background:#f5f5f4;margin:0;padding:24px">
<div style="max-width:480px;margin:0 auto;background:#fff;border-radius:16px;overflow:hidden;box-shadow:0 4px 20px rgba(0,0,0,0.08)">
  <div style="background:linear-gradient(135deg,#1a3a6b,#2563EB);padding:32px 36px;text-align:center">
    <div style="width:48px;height:48px;background:rgba(255,255,255,0.2);border-radius:12px;margin:0 auto 12px;display:flex;align-items:center;justify-content:center;font-size:22px;font-weight:800;color:#fff;line-height:48px;text-align:center">A</div>
    <h1 style="color:#fff;font-size:20px;margin:0;font-weight:600">ATOP 自动化测试编排调度平台</h1>
  </div>
  <div style="padding:36px">
    <p style="font-size:15px;color:#1A1A18;margin:0 0 8px">你好，<strong>%s</strong></p>
    <p style="font-size:14px;color:#5F5E5A;line-height:1.7;margin:0 0 24px">我们收到了你的密码重置请求。点击下方按钮重置密码，链接 <strong>%d 分钟</strong>内有效。</p>
    <div style="text-align:center;margin:0 0 24px">
      <a href="%s" style="display:inline-block;background:#2563EB;color:#fff;text-decoration:none;padding:13px 32px;border-radius:10px;font-size:15px;font-weight:600;letter-spacing:0.02em">重置密码</a>
    </div>
    <p style="font-size:12px;color:#9C9A92;line-height:1.6;margin:0 0 12px">如果按钮无法点击，请复制以下链接到浏览器：</p>
    <p style="font-size:11px;color:#9C9A92;word-break:break-all;background:#f5f5f4;padding:10px 12px;border-radius:8px;margin:0 0 24px">%s</p>
    <hr style="border:none;border-top:1px solid #f0f0f0;margin:0 0 16px">
    <p style="font-size:12px;color:#9C9A92;margin:0">如果你没有请求重置密码，请忽略此邮件，你的账户是安全的。</p>
  </div>
</div>
</body>
</html>`, username, expireMinutes, resetURL, resetURL)
}

// TemporaryPasswordEmailHTML generates the HTML email body for admin password resets.
func TemporaryPasswordEmailHTML(username, tempPassword string, expireHours int) string {
	return fmt.Sprintf(`<!DOCTYPE html>
<html>
<head><meta charset="UTF-8"></head>
<body style="font-family:'PingFang SC','Microsoft YaHei',sans-serif;background:#f5f5f4;margin:0;padding:24px">
<div style="max-width:480px;margin:0 auto;background:#fff;border-radius:16px;overflow:hidden;box-shadow:0 4px 20px rgba(0,0,0,0.08)">
  <div style="background:linear-gradient(135deg,#1a3a6b,#2563EB);padding:32px 36px;text-align:center">
    <div style="width:48px;height:48px;background:rgba(255,255,255,0.2);border-radius:12px;margin:0 auto 12px;display:flex;align-items:center;justify-content:center;font-size:22px;font-weight:800;color:#fff;line-height:48px;text-align:center">A</div>
    <h1 style="color:#fff;font-size:20px;margin:0;font-weight:600">ATOP 自动化测试编排调度平台</h1>
  </div>
  <div style="padding:36px">
    <p style="font-size:15px;color:#1A1A18;margin:0 0 8px">你好，<strong>%s</strong></p>
    <p style="font-size:14px;color:#5F5E5A;line-height:1.7;margin:0 0 20px">管理员已为你的账户重置密码，请在 <strong>%d 小时</strong>内使用下面的临时密码登录。登录后系统会强制要求你立即修改密码。</p>
    <div style="background:#f5f5f4;border:1px solid #e8e8e8;border-radius:12px;padding:16px 18px;margin:0 0 20px">
      <div style="font-size:12px;color:#8C8C8C;margin-bottom:8px">临时密码</div>
      <code style="display:block;font-size:20px;letter-spacing:0.08em;color:#1A1A18;font-weight:700;word-break:break-all">%s</code>
    </div>
    <p style="font-size:12px;color:#AD6800;line-height:1.6;background:#FFF7E6;padding:10px 12px;border-radius:8px;margin:0 0 16px">为了账户安全，请不要转发此邮件。临时密码 %d 小时后自动过期，完成密码修改后即不再使用。</p>
    <hr style="border:none;border-top:1px solid #f0f0f0;margin:0 0 16px">
    <p style="font-size:12px;color:#9C9A92;margin:0">如果你不知道这次重置操作，请立即联系系统管理员。</p>
  </div>
</div>
</body>
</html>`, username, expireHours, tempPassword, expireHours)
}
