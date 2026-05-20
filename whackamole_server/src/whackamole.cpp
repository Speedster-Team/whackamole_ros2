/**
 * whackamole_node — ROS 2 WebSocket bridge for the whack-a-mole robotic finger test bed.
 *
 * Listens for WebSocket connections from the Next.js iPad app and translates
 * the JSON event stream into ROS topics that the motion controller can subscribe to.
 *
 * Published topics:
 *   /whackamole/target  (whackamole_interfaces/Point)  — dot centre in iPad CSS pixels (x, y);
 *                                               z carries the dot diameter in pixels.
 *                                               Published on every "spawn" event.
 *   /whackamole/hit_ms  (std_msgs/Int32)        — finger reaction time in ms on a hit.
 *   /whackamole/miss    (std_msgs/String)        — miss reason string (e.g. "timeout").
 *
 * Parameters:
 *   host  (string, default "0.0.0.0")  — WebSocket bind address.
 *   port  (int,    default 8765)       — WebSocket port.
 *
 * The Boost.Beast WebSocket server runs on a dedicated thread so it does not
 * block the rclcpp executor. rclcpp publishers are thread-safe, so no extra
 * synchronisation is needed between the Beast thread and the ROS spin thread.
 *
 * Coordinate system: all x/y values are CSS pixels in the iPad viewport,
 * origin top-left. Your motion controller must calibrate these to robot
 * workspace coordinates.
 */
#include <rclcpp/rclcpp.hpp>
#include <std_msgs/msg/int32.hpp>
#include <std_msgs/msg/string.hpp>

#include "whackamole_interfaces/msg/point.hpp"

#include <boost/beast/core.hpp>
#include <boost/beast/websocket.hpp>
#include <boost/asio/ip/tcp.hpp>
#include <nlohmann/json.hpp>

#include <memory>
#include <string>
#include <thread>

namespace beast = boost::beast;
namespace ws_ns = beast::websocket;
namespace net = boost::asio;
using tcp = net::ip::tcp;
using json = nlohmann::json;

class WhackamoleNode : public rclcpp::Node
{
public:
  WhackamoleNode()
  :Node("whackamole"),
    ioc_()
  {
    declare_parameter("host", "0.0.0.0");
    declare_parameter("port", 8765);

    target_pub_ = create_publisher<whackamole_interfaces::msg::Point>("/whackamole/target", 10);
    hit_pub_ = create_publisher<std_msgs::msg::Int32>("/whackamole/hit_ms", 10);
    miss_pub_ = create_publisher<std_msgs::msg::String>("/whackamole/miss", 10);

    const auto host = get_parameter("host").as_string();
    const auto port = static_cast<uint16_t>(get_parameter("port").as_int());

    acceptor_ = std::make_shared<tcp::acceptor>(
      ioc_, tcp::endpoint{net::ip::make_address(host), port});

    RCLCPP_INFO(get_logger(), "listening on ws://%s:%d", host.c_str(), port);

    ws_thread_ = std::thread([this] {run_server();});
  }

  ~WhackamoleNode()
  {
    beast::error_code ec;
    acceptor_->close(ec);
    ioc_.stop();
    if (ws_thread_.joinable()) {ws_thread_.join();}
  }

private:
  void handle(const json & msg)
  {
    const auto type = msg.value("type", std::string{});

    if (type == "spawn") {
      const auto tgt = msg.value("target", json::object());
      const auto vp = msg.value("viewport", json::object());
      whackamole_interfaces::msg::Point pt;
      pt.x = tgt.value("x", 0.0);
      pt.y = tgt.value("y", 0.0);
      pt.screen_width = vp.value("width", 0);
      pt.screen_length = vp.value("height", 0);
      pt.size = msg.value("size", 0.0);
      target_pub_->publish(pt);
      RCLCPP_INFO(get_logger(),
        "[spawn] x=%.0f y=%.0f size=%.0f screen_width=%.0f screen_length=%.0f", pt.x, pt.y, pt.size,
        pt.screen_width, pt.screen_length);

    } else if (type == "hit") {
      std_msgs::msg::Int32 m;
      m.data = msg.value("reactionMs", 0);
      hit_pub_->publish(m);
      RCLCPP_INFO(get_logger(), "[hit] reaction=%dms", m.data);

    } else if (type == "miss") {
      std_msgs::msg::String m;
      m.data = msg.value("reason", std::string{"unknown"});
      miss_pub_->publish(m);
      RCLCPP_INFO(get_logger(), "[miss] reason=%s", m.data.c_str());

    } else if (type == "hello") {
      const auto vp = msg.value("viewport", json::object());
      RCLCPP_INFO(get_logger(), "[paired] viewport=%dx%d",
        vp.value("width", 0), vp.value("height", 0));

    } else if (type == "stop") {
      RCLCPP_INFO(get_logger(), "[stop]");
    }
  }

  void run_session(tcp::socket socket)
  {
    const auto peer = socket.remote_endpoint();
    RCLCPP_INFO(get_logger(), "[connect] %s:%d",
      peer.address().to_string().c_str(), peer.port());

    ws_ns::stream<tcp::socket> ws{std::move(socket)};
    beast::error_code ec;
    ws.accept(ec);
    if (ec) {
      RCLCPP_WARN(get_logger(), "ws handshake error: %s", ec.message().c_str());
      return;
    }

    beast::flat_buffer buf;
    for (;; ) {
      ws.read(buf, ec);
      if (ec) {break;}

      try {
        handle(json::parse(beast::buffers_to_string(buf.data())));
      } catch (const json::exception & e) {
        RCLCPP_WARN(get_logger(), "[bad json] %s", e.what());
      }
      buf.consume(buf.size());
    }

    RCLCPP_INFO(get_logger(), "[disconnect] %s:%d",
      peer.address().to_string().c_str(), peer.port());
  }

  void run_server()
  {
    for (;; ) {
      tcp::socket socket{ioc_};
      beast::error_code ec;
      acceptor_->accept(socket, ec);
      if (ec) {break;}

      std::thread([this, s = std::move(socket)]() mutable {
          run_session(std::move(s));
      }).detach();
    }
  }

  rclcpp::Publisher<whackamole_interfaces::msg::Point>::SharedPtr target_pub_;
  rclcpp::Publisher<std_msgs::msg::Int32>::SharedPtr       hit_pub_;
  rclcpp::Publisher<std_msgs::msg::String>::SharedPtr      miss_pub_;

  net::io_context                    ioc_;
  std::shared_ptr<tcp::acceptor> acceptor_;
  std::thread                        ws_thread_;
};

int main(int argc, char * argv[])
{
  rclcpp::init(argc, argv);
  rclcpp::spin(std::make_shared<WhackamoleNode>());
  rclcpp::shutdown();
  return 0;
}
